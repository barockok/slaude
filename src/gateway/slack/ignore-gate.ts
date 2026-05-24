import * as Ignores from "../../db/ignores";

export class IgnoreGate {
  /** Check if a message should be dropped due to active ignore. */
  shouldDrop(userId: string, channelId: string, threadTs: string): boolean {
    // Check user-level ignore first
    if (Ignores.findActiveForUser(userId)) return true;
    // Check thread-level ignore
    if (Ignores.findActiveForThread(channelId, threadTs)) return true;
    return false;
  }
}
