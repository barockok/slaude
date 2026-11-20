/**
 * Who is told that a turn failed. The person whose turn it was, privately; with no such
 * person (an unattended turn) the agent's manager, by DM, naming the channel; with neither,
 * no one: the failure is logged and counted by the private delivery path. It is never
 * posted to the channel. The error reaction on the message stays as the floor.
 */
import { privateSender, type PrivateClient } from "./private";

export async function notifyTurnFailure(
  client: PrivateClient,
  a: { userId?: string; managerId?: string; channel: string; thread?: string; text: string },
): Promise<"user" | "manager" | "none"> {
  if (a.userId) {
    await privateSender.send(client, {
      cls: "failure",
      kind: "turn_failure",
      userId: a.userId,
      channel: a.channel,
      ...(a.thread ? { thread: a.thread } : {}),
      text: a.text,
    });
    return "user";
  }
  if (a.managerId) {
    await privateSender.send(client, {
      cls: "sensitive",
      kind: "turn_failure_unattended",
      userId: a.managerId,
      channel: a.channel,
      text: `${a.text} (an unattended turn in <#${a.channel}>)`,
    });
    return "manager";
  }
  console.error(`[turn-failure] no one to tell for an unattended turn in ${a.channel}`);
  return "none";
}
