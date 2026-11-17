import { describe, expect, test } from "bun:test";
import { messageAuthor, messageBot, messageToText } from "../src/gateway/slack/message-text";

// Shape of a Grafana alert as conversations.replies returns it: no `user`,
// empty `text`, the body in a legacy attachment.
const grafanaAlert = {
  type: "message",
  subtype: "bot_message",
  ts: "1700000000.000100",
  bot_id: "B0GRAFANA",
  username: "Alert Bot",
  text: "",
  attachments: [
    {
      color: "#D63232",
      title: "[Warning] || Checkout API - High error rate Alerts Firing",
      title_link: "https://grafana.example/alerting/grafana/abc123/view",
      text: ":book: *Summary* : Checkout API - High error rate\n\n*Description* :\n:alert: <!subteam^S0ONCALL> ALERT: Checkout API - High error rate",
      footer: "Grafana v12.1.5",
      fallback: "[Warning] || Checkout API - High error rate Alerts Firing",
    },
  ],
};

describe("messageToText", () => {
  test("reads a Grafana alert whose body is only in attachments", () => {
    const out = messageToText(grafanaAlert);
    expect(out).toContain("[Warning] || Checkout API - High error rate Alerts Firing");
    expect(out).toContain("https://grafana.example/alerting/grafana/abc123/view");
    expect(out).toContain("*Description* :");
    expect(out).toContain("Grafana v12.1.5");
  });

  test("uses attachment fallback only when nothing else is there", () => {
    expect(messageToText({ text: "", attachments: [{ fallback: "only fallback" }] })).toBe("only fallback");
    expect(messageToText(grafanaAlert).match(/Alerts Firing/g)).toHaveLength(1);
  });

  test("plain user message is unchanged", () => {
    const m = {
      user: "U1",
      text: "hey <@U2> check this",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "hey " },
                { type: "user", user_id: "U2" },
                { type: "text", text: " check this" },
              ],
            },
          ],
        },
      ],
    };
    expect(messageToText(m)).toBe("hey <@U2> check this");
  });

  test("flattens rich_text when text is empty", () => {
    const m = {
      text: "",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "see " },
                { type: "link", url: "https://x.io", text: "doc" },
                { type: "emoji", name: "fire" },
              ],
            },
          ],
        },
      ],
    };
    expect(messageToText(m)).toBe("see doc (https://x.io):fire:");
  });

  const richTextMsg = (...elements: any[]) => ({ text: "", blocks: [{ type: "rich_text", elements }] });
  const section = (text: string) => ({ type: "rich_text_section", elements: [{ type: "text", text }] });

  test("keeps rich_text list items on their own lines", () => {
    const m = richTextMsg(
      section("Steps:\n"),
      { type: "rich_text_list", style: "bullet", indent: 0, elements: [section("one"), section("two")] },
      section("done"),
    );
    expect(messageToText(m)).toBe("Steps:\n• one\n• two\ndone");
  });

  test("numbers ordered rich_text lists and indents nested ones", () => {
    const m = richTextMsg(
      { type: "rich_text_list", style: "ordered", indent: 0, elements: [section("one"), section("two")] },
      { type: "rich_text_list", style: "bullet", indent: 1, elements: [section("nested")] },
      { type: "rich_text_list", style: "ordered", indent: 0, offset: 2, elements: [section("three")] },
    );
    expect(messageToText(m)).toBe("1. one\n2. two\n  • nested\n3. three");
  });

  test("keeps rich_text preformatted and quote blocks apart from their neighbours", () => {
    const m = richTextMsg(
      section("error:"),
      { type: "rich_text_preformatted", elements: [{ type: "text", text: "line 1\nline 2" }] },
      { type: "rich_text_quote", elements: [{ type: "text", text: "first\nsecond" }] },
      section("end"),
    );
    expect(messageToText(m)).toBe("error:\n```\nline 1\nline 2\n```\n> first\n> second\nend");
  });

  test("reads header, section fields and context blocks", () => {
    const m = {
      text: "Deploy finished",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Deploy finished" } },
        { type: "section", fields: [{ type: "mrkdwn", text: "*Service*: api-gateway" }, { type: "mrkdwn", text: "*Env*: prod" }] },
        { type: "context", elements: [{ type: "mrkdwn", text: "by ci-bot" }] },
        { type: "divider" },
      ],
    };
    expect(messageToText(m)).toBe("Deploy finished\n*Service*: api-gateway\n*Env*: prod\nby ci-bot");
  });

  test("renders attachment fields as title: value", () => {
    const m = { attachments: [{ title: "Alert", fields: [{ title: "severity", value: "warning" }, { value: "no title" }] }] };
    expect(messageToText(m)).toBe("Alert\nseverity: warning\nno title");
  });

  test("skips link unfurls when the URL is already in text", () => {
    const m = { text: "look <https://x.io>", attachments: [{ from_url: "https://x.io", title: "X", text: "preview" }] };
    expect(messageToText(m)).toBe("look <https://x.io>");
  });

  test("keeps the card body when text is a short fallback", () => {
    const m = {
      text: "[FIRING:1] High error rate",
      attachments: [{ title: "Checkout API", text: "error rate 12% over 5m", footer: "Grafana", fallback: "[FIRING:1] High error rate" }],
    };
    expect(messageToText(m)).toBe("[FIRING:1] High error rate\nCheckout API\nerror rate 12% over 5m\nGrafana");
  });

  test("keeps section blocks when text is a short fallback", () => {
    const m = {
      text: "Deploy finished for api-gateway",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Deploy finished" } },
        { type: "section", text: { type: "mrkdwn", text: "*Env*: prod, *Version*: 1.4.2" } },
      ],
    };
    expect(messageToText(m)).toBe("Deploy finished for api-gateway\nDeploy finished\n*Env*: prod, *Version*: 1.4.2");
  });

  test("empty or missing message gives empty string", () => {
    expect(messageToText(undefined)).toBe("");
    expect(messageToText({})).toBe("");
  });
});

describe("messageAuthor", () => {
  test("returns the user ID, or a bot: label for bot name, username, bot_id", () => {
    expect(messageAuthor({ user: "U1", bot_profile: { name: "x" } })).toBe("U1");
    expect(messageAuthor({ bot_id: "B1", bot_profile: { name: "Alert Bot" } })).toBe("bot:Alert Bot");
    expect(messageAuthor({ bot_id: "B1", username: "grafana" })).toBe("bot:grafana");
    expect(messageAuthor({ bot_id: "B1" })).toBe("bot:B1");
  });

  test("a bot named after a user ID never comes back as that bare ID", () => {
    expect(messageAuthor({ bot_id: "B1", username: "U0MANAGER1" })).toBe("bot:U0MANAGER1");
    expect(messageAuthor({ bot_id: "B1", bot_profile: { name: "U0MANAGER1" } })).toBe("bot:U0MANAGER1");
  });

  test("returns an empty string when nothing identifies the sender", () => {
    expect(messageAuthor({})).toBe("");
    expect(messageAuthor(undefined)).toBe("");
    expect(messageAuthor({ user: "" })).toBe("");
  });
});

describe("messageBot", () => {
  test("reports bot_id and bot_name apart from the user", () => {
    expect(messageBot({ bot_id: "B1", bot_profile: { name: "Alert Bot" }, username: "x" })).toEqual({
      bot_id: "B1",
      bot_name: "Alert Bot",
    });
    expect(messageBot({ bot_id: "B1", username: "U0MANAGER1" })).toEqual({ bot_id: "B1", bot_name: "U0MANAGER1" });
    expect(messageBot({ bot_id: "B1" })).toEqual({ bot_id: "B1" });
  });

  test("is empty for a human message", () => {
    expect(messageBot({ user: "U1", text: "hi" })).toEqual({});
    expect(messageBot(undefined)).toEqual({});
  });
});
