import { absoluteTime, relativeTime } from "../lib/format";

/** Relative time, with the absolute time on hover and for assistive tech. */
export function TimeAgo({ at }: { at: number }) {
  const abs = absoluteTime(at);
  return (
    <time dateTime={new Date(at).toISOString()} title={abs} className="sl-nowrap">
      {relativeTime(at)}
    </time>
  );
}
