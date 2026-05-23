import type { WASocket } from "@whiskeysockets/baileys";

/** Best-effort contact name lookup with a small in-memory TTL cache. */
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { name: string; at: number }>();

export async function resolveContactName(sock: WASocket, jid: string): Promise<string> {
  const hit = cache.get(jid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;

  try {
    // Try to get from contacts store
    const contact = sock.contacts.get(jid);
    if (contact?.name || contact?.notify) {
      const name = contact.name || contact.notify || jid;
      cache.set(jid, { name, at: Date.now() });
      return name;
    }

    // Fallback to JID without domain
    const phone = jid.split("@")[0];
    cache.set(jid, { name: phone, at: Date.now() });
    return phone;
  } catch {
    return jid.split("@")[0];
  }
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

export function getPhoneFromJid(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}
