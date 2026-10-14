/**
 * Public API. The CLI is the primary interface; these exports exist so you can embed
 * the pieces (adapter, diff engine, renderers) in your own tooling or tests.
 */
export { defineConfig, loadConfig, parseConfig, ConfigSchema } from './config.js';
export type { Config, ConfigInput } from './config.js';

export { parseClaudeCodeSession } from './adapters/claude-code.js';
export { replayability } from './adapters/rank.js';

export { TraceSchema, parseTrace, toolCalls } from './trace/schema.js';
export type { Trace, Step, ToolCall, Variant, Outcome, Usage } from './trace/schema.js';
export { buildTrace } from './trace/build.js';
export { DEFAULT_PRICES, estimateCostUsd } from './trace/pricing.js';
export { redactString, redactValue } from './redact/redact.js';

export { diffGroups, diffTraces, exitCodeFor, minRunsForSignificance } from './diff/diff.js';
export type { DiffReport, Finding, Verdict, MetricComparison } from './diff/types.js';

export { renderTerminal } from './report/terminal.js';
export { renderHtml } from './report/html.js';
export { renderMarkdown, renderSuiteMarkdown } from './report/markdown.js';
export { renderJson, toCiResult, toSuiteResult, badgeEndpoint } from './report/json.js';

export { runReplay } from './replay/replay.js';
export { estimateReplay } from './replay/estimate.js';
export { ClaudeCodeRunner } from './replay/claude-runner.js';
export { FakeRunner, parseScenario } from './replay/fake-runner.js';
export type { AgentRunner, RunRequest } from './replay/runner.js';

export { Store } from './store/store.js';
export { VERSION } from './version.js';
