import type { WASocket } from "@whiskeysockets/baileys";

/** Best-effort contact name lookup with a small in-memory TTL cache. */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { name: string; at: number }>();

export async function resolveContactName(_sock: WASocket, jid: string): Promise<string> {
  const hit = cache.get(jid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;

  // WASocket doesn't expose a contacts store in the current Baileys version.
  // Fallback to phone number from JID.
  const phone = jid.split("@")[0] ?? jid;
  const name = phone;
  cache.set(jid, { name, at: Date.now() });
  return name;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

export function getPhoneFromJid(jid: string): string {
  return (jid.split("@")[0] ?? jid).split(":")[0] ?? jid;
}
