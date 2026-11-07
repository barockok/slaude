/**
 * Display helpers for the portal.
 */
const LINKED_VIA: Record<string, string> = {
  "signed-link": "/link in Slack",
};

/** "/link in Slack" for the signed link; other methods in sentence case. */
export function linkedViaLabel(via: string): string {
  const known = LINKED_VIA[via];
  if (known) return known;
  const s = via.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Unknown";
}
