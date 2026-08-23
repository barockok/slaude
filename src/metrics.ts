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

type Histogram = {
  type: "histogram";
  help: string;
  buckets: number[];
  /** seriesKey → { counts per bucket (cumulative at render), sum, count } */
  series: Map<string, { counts: number[]; sum: number; count: number }>;
};

type Metric = Counter | Gauge | Histogram;

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

  /**
   * Prometheus histogram (fixed buckets, cumulative `_bucket{le=...}` +
   * `_sum` + `_count` on render). Needed for latency SLOs the spec states as
   * percentiles (§8: claim-latency p95 < 500ms) — a gauge of the last
   * observation cannot answer `histogram_quantile()`.
   */
  histogram(name: string, help: string, buckets: number[]): {
    observe: (value: number, labels?: LabelMap) => void;
  } {
    let m = this.#metrics.get(name);
    if (!m) {
      m = { type: "histogram", help, buckets: [...buckets].sort((a, b) => a - b), series: new Map() };
      this.#metrics.set(name, m);
    }
    const hist = m as Histogram;
    return {
      observe: (value, labels = {}) => {
        const key = seriesKey(labels);
        let s = hist.series.get(key);
        if (!s) {
          s = { counts: hist.buckets.map(() => 0), sum: 0, count: 0 };
          hist.series.set(key, s);
        }
        // Non-cumulative per-bucket increments; cumulated at render time.
        const idx = hist.buckets.findIndex((b) => value <= b);
        if (idx >= 0) s.counts[idx]!++;
        s.sum += value;
        s.count++;
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
        if (m.type === "histogram") {
          const s = m.series.get(key)!;
          let cum = 0;
          for (let i = 0; i < m.buckets.length; i++) {
            cum += s.counts[i]!;
            out.push(`${name}_bucket${renderLabels({ ...merged, le: String(m.buckets[i]) })} ${cum}`);
          }
          out.push(`${name}_bucket${renderLabels({ ...merged, le: "+Inf" })} ${s.count}`);
          out.push(`${name}_sum${renderLabels(merged)} ${s.sum}`);
          out.push(`${name}_count${renderLabels(merged)} ${s.count}`);
        } else {
          out.push(`${name}${renderLabels(merged)} ${m.series.get(key)}`);
        }
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
  httpRequestsTotal: metrics.counter("slaude_http_requests_total", "Slack ingress HTTP responses (/slack/*), labeled by route and status."),
  v1JobEventsTotal: metrics.counter("slaude_v1_job_events_total", "Node job telemetry received on /v1/jobs/:id (ack|fail), labeled by event."),
  v1ToolCallsTotal: metrics.counter("slaude_v1_tool_calls_total", "REST tool-plane invocations on /v1/tools/<server>/<tool>, labeled by server + tool."),
  // Node runtime (spec §6).
  nodeSessionsLive: metrics.gauge("slaude_node_sessions_live", "Warm SDK Query sessions held by this node."),
  nodeTurnsTotal: metrics.counter("slaude_node_turns_total", "Turn jobs processed by this node, labeled by result (done|error|skipped|requeued)."),
  nodeTurnDuration: metrics.histogram(
    "slaude_node_turn_duration_seconds",
    "Wall-clock duration of turn jobs run on this node (lock wait included).",
    [1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900],
  ),
  nodeClaimLatency: metrics.histogram(
    "slaude_node_queue_claim_latency_seconds",
    "enqueue→claim latency of turn jobs claimed by this node (spec §8 SLO: p95 < 0.5s).",
    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  ),
  // Gateway ingress (spec §6): accepted Slack events dispatched to handlers
  // (post-signature, post-registry lookup), labeled by event type.
  gatewayEventsTotal: metrics.counter("slaude_gateway_events_total", "Slack events accepted and dispatched by this gateway replica, labeled by event type."),
  // Gateway queue-side (spec §6), set by the reaper leader loop.
  queueDepth: metrics.gauge("slaude_queue_depth", "Turn jobs waiting or delayed, labeled by queue."),
  nodesAlive: metrics.gauge("slaude_nodes_alive", "Node heartbeat keys currently live."),
  sessionsWarm: metrics.gauge("slaude_sessions_warm", "Sessions registered warm on some node."),
};
