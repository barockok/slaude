/**
 * Prometheus-compatible metrics registry. Hand-rendered text format —
 * no external prom-client dep. Singleton accessed via `metrics`.
 *
 * Static labels (env `SLAUDE_METRICS_LABELS="agent=hermes,env=prod"`)
 * are appended to every series so operators can tag a deploy.
 */

export type LabelMap = Record<string, string>;

type Counter = {
  type: "counter";
  help: string;
  series: Map<string, number>;
};

type Gauge = {
  type: "gauge";
  help: string;
  series: Map<string, number>;
};

type Metric = Counter | Gauge;

/** Parse `"a=1,b=2"` → `{a:"1",b:"2"}`. Tolerant: empty parts dropped, malformed dropped. */
export function parseLabels(raw: string | undefined): LabelMap {
  if (!raw) return {};
  const out: LabelMap = {};
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Render Prometheus label-set body, e.g. `{a="1",b="2"}` or `""` if empty. */
function renderLabels(labels: LabelMap): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const body = keys
    .map((k) => `${k}="${labels[k]!.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
  return `{${body}}`;
}

/** Deterministic key for a label-set so counters/gauges can index series. */
function seriesKey(labels: LabelMap): string {
  return renderLabels(labels);
}

export class Registry {
  #metrics = new Map<string, Metric>();
  #static: LabelMap;

  constructor(staticLabels: LabelMap = {}) {
    this.#static = staticLabels;
  }

  setStaticLabels(labels: LabelMap) {
    this.#static = labels;
  }

  counter(name: string, help: string): {
    inc: (labels?: LabelMap, by?: number) => void;
  } {
    let m = this.#metrics.get(name);
    if (!m) {
      m = { type: "counter", help, series: new Map() };
      this.#metrics.set(name, m);
    }
    const counter = m as Counter;
    return {
      inc: (labels = {}, by = 1) => {
        const key = seriesKey(labels);
        counter.series.set(key, (counter.series.get(key) ?? 0) + by);
        // Stash labels alongside the key for render time.
        labelStore.set(`${name}|${key}`, labels);
      },
    };
  }

  gauge(name: string, help: string): {
    set: (value: number, labels?: LabelMap) => void;
  } {
    let m = this.#metrics.get(name);
    if (!m) {
      m = { type: "gauge", help, series: new Map() };
      this.#metrics.set(name, m);
    }
    const gauge = m as Gauge;
    return {
      set: (value, labels = {}) => {
        const key = seriesKey(labels);
        gauge.series.set(key, value);
        labelStore.set(`${name}|${key}`, labels);
      },
    };
  }

  render(): string {
    const out: string[] = [];
    const names = Array.from(this.#metrics.keys()).sort();
    for (const name of names) {
      const m = this.#metrics.get(name)!;
      out.push(`# HELP ${name} ${m.help}`);
      out.push(`# TYPE ${name} ${m.type}`);
      const keys = Array.from(m.series.keys()).sort();
      for (const key of keys) {
        const dynLabels = labelStore.get(`${name}|${key}`) ?? {};
        const merged: LabelMap = { ...this.#static, ...dynLabels };
        out.push(`${name}${renderLabels(merged)} ${m.series.get(key)}`);
      }
    }
    return out.join("\n") + "\n";
  }
}

// Module-scoped label store keyed by `${metricName}|${seriesKey}`. Lets render
// merge static labels w/ the original dynamic labels (we don't store labels
// in the series map itself because keys are already the rendered form).
const labelStore = new Map<string, LabelMap>();

// Import env solely for its dotenv side-effect — guarantees ~/.slaude/.env is
// loaded before we read SLAUDE_METRICS_LABELS at module init.
import { env as _env } from "./config/env";
void _env;

export const metrics = new Registry(parseLabels(process.env.SLAUDE_METRICS_LABELS));

// Pre-declared metric handles so callers don't have to remember names.
export const m = {
  sessionsLive: metrics.gauge("slaude_sessions_live", "Number of live SDK sessions in this process."),
  turnsTotal: metrics.counter("slaude_turns_total", "Completed turns, labeled by result."),
  toolCallsTotal: metrics.counter("slaude_tool_calls_total", "Tool invocations, labeled by tool name."),
  tokensTotal: metrics.counter("slaude_tokens_total", "Tokens consumed, labeled by kind, channel_id, and model."),
  contextWindowPct: metrics.gauge("slaude_context_window_pct", "Most recent context-window usage fraction (0..1)."),
  stopGuardBlockedTotal: metrics.counter("slaude_stop_guard_blocked_total", "Times the Stop hook blocked an agent from stopping."),
  stopGuardFailedTotal: metrics.counter("slaude_stop_guard_failed_total", "Times the Stop hook blocked but the agent still stopped without satisfying the guard."),
  errorsTotal: metrics.counter("slaude_errors_total", "Errors raised during a turn, labeled by kind."),
  slackDropsTotal: metrics.counter("slaude_slack_drops_total", "Inbound Slack events dropped before processing, labeled by reason."),
  disengagedSuppressedTotal: metrics.counter("slaude_disengaged_suppressed_total", "Messages recorded into a disengaged thread's session transcript but suppressed by the UserPromptSubmit hook (no model run)."),
  userTurnsTotal: metrics.counter("slaude_user_turns_total", "Inbound user turns, labeled by user_id + user_name (opt-in via SLAUDE_METRICS_PER_USER=1)."),
};
