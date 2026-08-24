import * as Ignores from "../../db/ignores";

export class IgnoreGate {
  /** Check if a message should be dropped due to active ignore. */
  async shouldDrop(userId: string, channelId: string, threadTs: string): Promise<boolean> {
    // Check user-level ignore first
    if (await Ignores.findActiveForUser(userId)) return true;
    // Check thread-level ignore
    if (await Ignores.findActiveForThread(channelId, threadTs)) return true;
    return false;
  }
}
