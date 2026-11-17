/**
 * Where an upload's bytes may be sent. Slack's presigned `upload_url` is an
 * https URL on `files.slack.com`; the node sends a file to whatever URL the
 * gateway hands it, so both sides check it first (the gateway at begin, the
 * node again before the first byte). A URL on any other host, any other scheme,
 * with credentials in it, or on a non-default port is refused, so a wrong
 * answer can never turn the upload into a request to an internal address.
 *
 * `SLAUDE_UPLOAD_ALLOWED_HOSTS` (comma-separated exact host names) replaces the
 * default list, for a test double or an enterprise host. A host named there may
 * also be reached over plain http and on any port (an operator's explicit
 * opt-in); nothing else may.
 */
const DEFAULT_HOSTS = ["files.slack.com"];

function listed(): { hosts: string[]; custom: boolean } {
  const raw = (process.env.SLAUDE_UPLOAD_ALLOWED_HOSTS ?? "").trim();
  if (!raw) return { hosts: DEFAULT_HOSTS, custom: false };
  const hosts = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? { hosts, custom: true } : { hosts: DEFAULT_HOSTS, custom: false };
}

export function checkUploadUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const { hosts, custom } = listed();
  // URL.hostname keeps brackets for IPv6, which no list entry names.
  if (!hosts.includes(u.hostname.toLowerCase())) return false;
  if (u.protocol === "https:") return custom || u.port === "";
  return custom && u.protocol === "http:";
}
