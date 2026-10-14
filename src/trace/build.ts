import { createHash } from 'node:crypto';
import { estimateCostUsd, EMPTY_USAGE, type Price } from './pricing.js';
import {
  TRACE_SCHEMA_VERSION,
  type Outcome,
  type Step,
  type Trace,
  type Usage,
  type Variant,
} from './schema.js';

export interface TraceParts {
  source: Trace['source'];
  variant?: Variant;
  label?: string;
  task: string;
  humanTurns: number;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  steps: Step[];
  usage?: Usage;
  /** Cost reported by the producer, if any. Preferred over an estimate. */
  reportedCostUsd?: number | null;
  /** Files changed according to ground truth (e.g. git diff). Overrides derivation. */
  filesChanged?: string[];
  outcome: Outcome;
  notes?: string[];
  prices?: Record<string, Price>;
  id?: string;
}

function uniqSorted(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}

/** Assemble a validated-shape Trace, deriving files, duration, cost and a stable id. */
export function buildTrace(parts: TraceParts): Trace {
  const usage = parts.usage ?? EMPTY_USAGE;
  const written: string[] = [];
  const read: string[] = [];
  for (const s of parts.steps) {
    const t = s.tool;
    if (!t?.target || !t.ok) continue;
    if (t.category === 'write') written.push(t.target);
    else if (t.category === 'read') read.push(t.target);
  }

  const start = parts.startedAt ? Date.parse(parts.startedAt) : NaN;
  const end = parts.endedAt ? Date.parse(parts.endedAt) : NaN;
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;

  let costUsd: number | null;
  let costSource: Trace['costSource'];
  if (typeof parts.reportedCostUsd === 'number') {
    costUsd = parts.reportedCostUsd;
    costSource = 'reported';
  } else {
    costUsd = estimateCostUsd(parts.model, usage, parts.prices);
    costSource = costUsd === null ? 'unknown' : 'estimated';
  }

  const id =
    parts.id ??
    createHash('sha256')
      .update(
        JSON.stringify([parts.source.sessionId ?? '', parts.variant?.name ?? '', parts.task, parts.startedAt ?? '', parts.steps.length]),
      )
      .digest('hex')
      .slice(0, 12);

  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    id,
    ...(parts.label !== undefined ? { label: parts.label } : {}),
    source: parts.source,
    ...(parts.variant ? { variant: parts.variant } : {}),
    task: parts.task,
    humanTurns: parts.humanTurns,
    ...(parts.model ? { model: parts.model } : {}),
    ...(parts.startedAt ? { startedAt: parts.startedAt } : {}),
    ...(parts.endedAt ? { endedAt: parts.endedAt } : {}),
    durationMs,
    steps: parts.steps.map((s, i) => ({ ...s, index: i })),
    usage,
    costUsd,
    costSource,
    filesChanged: uniqSorted(parts.filesChanged ?? written),
    filesRead: uniqSorted(read),
    outcome: parts.outcome,
    notes: parts.notes ?? [],
  };
}
