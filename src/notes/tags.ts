export const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeTag(raw: string): string | null {
  const slackChannel = raw.match(/^<#(?:[CGD][A-Z0-9]+)\|([^>]+)>$/i);
  const value = (slackChannel?.[1] ?? raw).replace(/^#/, "").toLowerCase();
  return TAG_PATTERN.test(value) ? value : null;
}
