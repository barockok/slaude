/**
 * How the gateway wires `/box` and the forced-refresh notice. The gateway's
 * message handler cannot be driven without a Slack transport, so these read
 * its source, as tests/gateway/reload-routing.test.ts does for reloads.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync("src/gateway/core/gateway.ts", "utf8");
const boxBranch = src.slice(src.indexOf('if (slash.kind === "box" && queueDispatch) {'), src.indexOf('if (slash.kind === "model") {'));
const notifier = src.slice(src.indexOf("queueDispatch?.onBoxRefreshed?.("), src.indexOf("queueDispatch?.onBoxRefreshed?.(") + 1600);

describe("gateway wiring of /box", () => {
  test("with boxes off (or no node queue) /box is not a command: it reaches the model as text, as before", () => {
    expect(src).toContain("const boxCommandsOn = env.box.enabled() && !!queueDispatch;");
    expect(src).toContain('(parsed?.kind === "box" && !boxCommandsOn) ? null : parsed');
    expect(src).toContain("boxes: boxCommandsOn");
  });

  test("the command branch exists, answers privately, and ends the warm session through the one reload route", () => {
    expect(boxBranch.length).toBeGreaterThan(200);
    expect(boxBranch).toContain("runBoxCommand(slash.action");
    expect(boxBranch).toContain("reload: (id) => void reloadSession(id)");
    expect(boxBranch).toContain("await reply(r.text)");
    // Nothing in the branch posts to the channel.
    expect(boxBranch).not.toContain("announce(");
    expect(boxBranch).not.toContain("chat.postMessage");
  });

  test("refresh is allowed for whoever may start the session over, and never during a turn on any side", () => {
    expect(boxBranch).toContain("mayRefresh: () => isManagerOrApprover(dispatch?.personaId, userId, channelId, teamId)");
    expect(boxBranch).toContain("agent.isTurnInFlight(id)");
    expect(boxBranch).toContain("queueDispatch.turns.hasPending(id)");
    expect(boxBranch).toContain("queueDispatch.registry.turnRunning(id)");
  });

  test("a failure reading the box changes nothing and shows no detail", () => {
    expect(boxBranch).toContain("The box could not be read, so nothing was changed.");
  });

  test("the forced-refresh notice goes to one person through the private sender, and only for a message a person sent", () => {
    expect(notifier).toContain('n.meta.origin !== "slack"');
    expect(notifier).toContain("privateSender.send(");
    expect(notifier).toContain("forcedRefreshNotice(");
    expect(notifier).not.toContain("publicFallback");
    expect(notifier).not.toContain("chat.postMessage");
  });
});
