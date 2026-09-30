import { viewHistory } from "./history";
import { SCENARIOS } from "./scenarios";
import { findTag, messageText, stripTags } from "./tag";
import type { MockReply, MockRequest } from "./types";

/** Pure: the same request always yields the same reply. */
export function resolveReply(req: MockRequest): MockReply {
  const found = findTag(req);
  if (!found) return { kind: "text", content: "mock: untagged request" };
  const scenario = SCENARIOS.get(found.tag.name);
  if (!scenario) return { kind: "text", content: `mock: unknown scenario ${found.tag.name}` };
  return scenario.reply({
    tag: found.tag,
    view: viewHistory(req, found.index),
    userText: stripTags(messageText(req.messages[found.index]!)),
  });
}
