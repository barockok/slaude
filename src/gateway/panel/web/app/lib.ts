// Small pure helpers: status vocabulary, relative/exact time, persona color.
import type { SessionSummary } from "./types";

export interface StatusMeta { label: string; color: string; bg: string; running?: boolean; }

// Honest, high-contrast status encoding. This is the scan-speed win over
// Temporal's pale pastel pills: a saturated leading dot + row accent per state.
// Colors are brand status tokens; unknown states degrade to neutral.
const STATUS: Record<string, StatusMeta> = {
  running: { label: "Running", color: "var(--st-blue)", bg: "var(--st-blue-bg)", running: true },
  waiting: { label: "Waiting", color: "var(--st-orange)", bg: "var(--st-orange-bg)" },
  error: { label: "Error", color: "var(--st-red)", bg: "var(--st-red-bg)" },
  done: { label: "Done", color: "var(--st-green)", bg: "var(--st-green-bg)" },
  idle: { label: "Idle", color: "var(--st-neutral)", bg: "var(--st-neutral-bg)" },
  stopped: { label: "Stopped", color: "var(--st-neutral)", bg: "var(--st-neutral-bg)" },
};

export function statusMeta(status: string): StatusMeta {
  return STATUS[status] ?? { label: status || "Unknown", color: "var(--st-neutral)", bg: "var(--st-neutral-bg)" };
}

const PERSONA_COLORS = ["#853291", "#056dce", "#009c6a", "#f7941d", "#d73630", "#5b21b6"];
export function personaColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PERSONA_COLORS[h % PERSONA_COLORS.length]!;
}
export const personaInitial = (id: string) => (id[0] ?? "?").toUpperCase();

export function relTime(ts: number, base = Date.now()): string {
  const s = Math.max(0, Math.round((base - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Exact machine timestamp, centisecond + explicit TZ (matches Temporal's honesty).
export function exactTime(ts: number): string {
  const d = new Date(ts);
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const tzh = String(Math.floor(Math.abs(tz) / 60)).padStart(2, "0");
  const cs = String(Math.floor(d.getMilliseconds() / 10)).padStart(2, "0");
  const base = d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  return `${base}.${cs} GMT${sign}${tzh}`;
}

export const shortId = (id: string) => id;

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function summarize(sessions: SessionSummary[]) {
  const by: Record<string, number> = {};
  let warm = 0, engaged = 0;
  for (const s of sessions) {
    by[s.status] = (by[s.status] ?? 0) + 1;
    if (s.warm) warm++;
    if (s.engaged) engaged++;
  }
  return { total: sessions.length, by, warm, engaged };
}

export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const;
export const MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"] as const;
