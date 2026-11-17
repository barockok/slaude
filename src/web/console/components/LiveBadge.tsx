import { Badge } from "../../ui";

/** Live: something can serve the agent now. Unknown: no node registry to ask. */
export function LiveBadge({ live }: { live: boolean | null }) {
  if (live === null) return <Badge>Unknown</Badge>;
  return live ? <Badge tone="success">Live</Badge> : <Badge>Offline</Badge>;
}
