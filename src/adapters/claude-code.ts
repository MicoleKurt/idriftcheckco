import { z } from 'zod';
import { clip, redactString, redactValue } from '../redact/redact.js';
import { buildTrace } from '../trace/build.js';
import { categorize, targetOf } from '../trace/classify.js';
import { addUsage, EMPTY_USAGE, type Price } from '../trace/pricing.js';
import type { Outcome, Step, Trace, Usage } from '../trace/schema.js';

/**
 * Adapter for Claude Code session transcripts (JSONL). The format is undocumented
 * and has changed across versions (see docs/session-format.md), so this file is
 * the ONLY place that knows field names. It validates a minimal subset, ignores
 * everything else, and never throws on unknown entry types.
 */
export const ADAPTER_ID = 'claude-code@1';

const Envelope = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  logicalParentUuid: z.string().nullable().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isApiErrorMessage: z.boolean().optional(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  version: z.string().optional(),
  cwd: z.string().optional(),
  message: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
});
type Entry = z.infer<typeof Envelope>;

const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});
const UsageRaw = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
});
const AssistantMessage = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  content: z.unknown().optional(),
  stop_reason: z.string().nullable().optional(),
  usage: UsageRaw.optional(),
});

/** Prefixes of "user" entries that are harness chatter, not human prompts. */
const NON_PROMPT_PREFIXES = [
  '<local-command',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<task-notification>',
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
];

export interface ParseOptions {
  /** Price overrides, keyed by normalized model id. */
  prices?: Record<string, Price>;
  /** Fallback session id (usually the file name). */
  sessionId?: string;
  label?: string;
}

function blocksOf(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [];
}

function humanText(entry: Entry): string | undefined {
  const msg = entry.message as { content?: unknown } | undefined;
  const content = msg?.content;
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else {
    const parts: string[] = [];
    for (const b of blocksOf(content)) {
      const t = TextBlock.safeParse(b);
      if (t.success) parts.push(t.data.text);
    }
    text = parts.length > 0 ? parts.join('\n') : undefined;
  }
  return text?.trim() ? text : undefined;
}

function isHumanPrompt(entry: Entry): boolean {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return false;
  const text = humanText(entry);
  if (!text) return false;
  // tool_result carriers have array content with no text blocks, so they return undefined above.
  return !NON_PROMPT_PREFIXES.some((p) => text.startsWith(p));
}

function resultToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const t = TextBlock.safeParse(b);
        return t.success ? t.data.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** Keep only ancestors of the final leaf so abandoned (rewound) branches are dropped. */
function selectMainPath(entries: Entry[], notes: string[]): Entry[] {
  const byUuid = new Map<string, Entry>();
  for (const e of entries) if (e.uuid) byUuid.set(e.uuid, e);
  const messages = entries.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
  const leaf = [...messages].reverse().find((e) => e.uuid);
  if (!leaf || messages.some((m) => !m.uuid)) return entries;

  const keep = new Set<string>();
  let cur: Entry | undefined = leaf;
  while (cur?.uuid && !keep.has(cur.uuid)) {
    keep.add(cur.uuid);
    const parent: string | null | undefined = cur.parentUuid ?? cur.logicalParentUuid;
    cur = parent ? byUuid.get(parent) : undefined;
  }
  const kept = entries.filter((e) => !e.uuid || keep.has(e.uuid));
  const keptMessages = kept.filter((e) => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
  // A broken parent link would silently drop most of the session; prefer file order then.
  if (keptMessages.length < messages.length * 0.6) {
    notes.push('Conversation tree could not be followed; using file order.');
    return entries;
  }
  if (keptMessages.length < messages.length) {
    notes.push(`Ignored ${messages.length - keptMessages.length} message(s) from abandoned branches.`);
  }
  return kept;
}

/**
 * Parse a Claude Code JSONL session (or `--output-format stream-json` output, which
 * uses the same message shapes) into a normalized Trace.
 */
export function parseClaudeCodeSession(jsonl: string, opts: ParseOptions = {}): Trace {
  const notes: string[] = [];
  const entries: Entry[] = [];
  let malformed = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    const env = Envelope.safeParse(raw);
    if (env.success) entries.push(env.data);
    else malformed++;
  }
  if (malformed > 0) notes.push(`Skipped ${malformed} unparsable line(s).`);

  const sidechain = entries.filter((e) => e.isSidechain).length;
  if (sidechain > 0) notes.push(`Ignored ${sidechain} subagent (sidechain) entr${sidechain === 1 ? 'y' : 'ies'}.`);

  const path = selectMainPath(entries, notes).filter((e) => !e.isSidechain);
  const messages = path.filter((e) => e.type === 'user' || e.type === 'assistant');
  const resultLine = [...entries].reverse().find((e) => e.type === 'result');

  const cwd = entries.find((e) => e.cwd)?.cwd;
  const sourceVersion = entries.find((e) => e.version)?.version;
  const sessionId = opts.sessionId ?? entries.find((e) => e.sessionId)?.sessionId;

  // Task and human turn count.
  const prompts = messages.filter(isHumanPrompt);
  const firstPrompt = prompts[0] ? humanText(prompts[0]) : undefined;
  const task = redactString(firstPrompt ?? '(no prompt found)');
  if (!firstPrompt) notes.push('No human prompt found in transcript.');

  // Steps, usage (deduplicated by API message id), model counts.
  const steps: Step[] = [];
  const pending = new Map<string, Step>();
  const usageByMessage = new Map<string, Usage>();
  const modelCount = new Map<string, number>();
  let lastAssistant: Entry | undefined;
  let lastAssistantHadText = false;
  let lastAssistantText: string | undefined;
  let apiError = false;
  let interrupted = false;
  let anonUsageKey = 0;

  for (const e of messages) {
    const msg = e.message;
    if (e.type === 'assistant') {
      const am = AssistantMessage.safeParse(msg);
      if (!am.success) continue;
      const m = am.data;
      lastAssistant = e;
      if (e.isApiErrorMessage) apiError = true;
      if (m.model && m.model !== '<synthetic>') modelCount.set(m.model, (modelCount.get(m.model) ?? 0) + 1);
      if (m.usage) {
        const key = m.id ?? `anon-${anonUsageKey++}`;
        const u = m.usage;
        const next: Usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        };
        const prev = usageByMessage.get(key);
        // The same API message is repeated per content block; keep the per-field max.
        usageByMessage.set(
          key,
          prev
            ? {
                inputTokens: Math.max(prev.inputTokens, next.inputTokens),
                outputTokens: Math.max(prev.outputTokens, next.outputTokens),
                cacheReadTokens: Math.max(prev.cacheReadTokens, next.cacheReadTokens),
                cacheWriteTokens: Math.max(prev.cacheWriteTokens, next.cacheWriteTokens),
              }
            : next,
        );
      }
      for (const b of blocksOf(m.content)) {
        const text = TextBlock.safeParse(b);
        if (text.success) {
          if (text.data.text.trim()) {
            const clean = redactString(text.data.text);
            steps.push({ index: 0, ...(e.timestamp ? { at: e.timestamp } : {}), kind: 'text', text: clip(clean, 400) });
            lastAssistantHadText = true;
            lastAssistantText = clean;
          }
          continue;
        }
        const use = ToolUseBlock.safeParse(b);
        if (use.success) {
          const input = use.data.input ?? {};
          const category = categorize(use.data.name);
          const target = targetOf(use.data.name, category, input, cwd);
          const step: Step = {
            index: 0,
            ...(e.timestamp ? { at: e.timestamp } : {}),
            kind: 'tool',
            tool: {
              id: use.data.id,
              name: use.data.name,
              category,
              ...(target !== undefined ? { target: redactString(target) } : {}),
              args: redactValue(input),
              ok: true,
              resultPreview: '',
            },
          };
          steps.push(step);
          pending.set(use.data.id, step);
          lastAssistantHadText = false;
        }
      }
    } else {
      const content = (msg as { content?: unknown } | undefined)?.content;
      for (const b of blocksOf(content)) {
        const r = ToolResultBlock.safeParse(b);
        if (r.success) {
          const step = pending.get(r.data.tool_use_id);
          if (step?.tool) {
            step.tool.ok = !r.data.is_error;
            step.tool.resultPreview = clip(redactString(resultToText(r.data.content)), 300);
          }
        }
      }
      const text = humanText(e);
      if (text?.startsWith('[Request interrupted by user')) interrupted = true;
      else if (isHumanPrompt(e)) interrupted = false;
    }
  }

  let usage: Usage = EMPTY_USAGE;
  for (const u of usageByMessage.values()) usage = addUsage(usage, u);

  const model = [...modelCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (modelCount.size > 1) notes.push(`Multiple models used: ${[...modelCount.keys()].join(', ')}.`);

  const lastMessage = messages[messages.length - 1];
  let status: Outcome['status'] = 'unknown';
  if (apiError && lastAssistant?.isApiErrorMessage) status = 'error';
  else if (interrupted) status = 'interrupted';
  else if (lastMessage?.type === 'assistant' && lastAssistantHadText) status = 'completed';
  if (resultLine) {
    const r = resultLine as Record<string, unknown>;
    if (r.is_error === true) status = 'error';
    else if (r.subtype === 'success') status = 'completed';
  }

  const timestamps = messages.map((m) => m.timestamp).filter((t): t is string => !!t);
  const reported = typeof resultLine?.total_cost_usd === 'number' ? resultLine.total_cost_usd : undefined;

  return buildTrace({
    ...(sessionId ? { id: sessionId } : {}),
    source: {
      kind: 'claude-code',
      adapter: ADAPTER_ID,
      ...(sessionId ? { sessionId } : {}),
      ...(sourceVersion ? { sourceVersion } : {}),
    },
    ...(opts.label ? { label: opts.label } : {}),
    task,
    humanTurns: prompts.length,
    ...(model ? { model } : {}),
    ...(timestamps[0] ? { startedAt: timestamps[0] } : {}),
    ...(timestamps.length > 0 ? { endedAt: timestamps[timestamps.length - 1]! } : {}),
    steps,
    usage,
    ...(reported !== undefined ? { reportedCostUsd: reported } : {}),
    outcome: {
      status,
      ...(lastAssistantText ? { finalMessage: clip(lastAssistantText, 600) } : {}),
    },
    notes,
    ...(opts.prices ? { prices: opts.prices } : {}),
  });
}
