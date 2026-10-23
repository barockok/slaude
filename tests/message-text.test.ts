import { describe, expect, test } from "bun:test";
import { messageAuthor, messageToText } from "../src/gateway/slack/message-text";

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

  test("empty or missing message gives empty string", () => {
    expect(messageToText(undefined)).toBe("");
    expect(messageToText({})).toBe("");
  });
});

describe("messageAuthor", () => {
  test("prefers user, then bot name, username, bot_id", () => {
    expect(messageAuthor({ user: "U1", bot_profile: { name: "x" } })).toBe("U1");
    expect(messageAuthor({ bot_id: "B1", bot_profile: { name: "Alert Bot" } })).toBe("Alert Bot");
    expect(messageAuthor({ bot_id: "B1", username: "grafana" })).toBe("grafana");
    expect(messageAuthor({ bot_id: "B1" })).toBe("B1");
  });
});
