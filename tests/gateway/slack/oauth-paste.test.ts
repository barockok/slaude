import { describe, expect, it } from "bun:test";
import { OAUTH_PASTE_ACTION, OAUTH_PASTE_VIEW, oauthLinkBlocks, oauthPasteModal, readOAuthPasteValue } from "../../../src/gateway/slack/oauth-paste";
import { decodeRemoteOffer } from "../../../src/gateway/core/remote-command";

const offer = { sessionId: "S1", teamId: "T1", channelId: "C1", threadTs: "1.1", userId: "U1", issuedAt: Date.now() };

describe("oauth paste form", () => {
  it("the link message carries the link and an Enter code button bound to the offer", async () => {
    const blocks = oauthLinkBlocks("svc", "https://idp.example/authorize?x=1", offer) as any[];
    expect(JSON.stringify(blocks)).toContain("https://idp.example/authorize?x=1");
    const btn = blocks.find((b) => b.type === "actions").elements[0];
    expect(btn.action_id).toBe(OAUTH_PASTE_ACTION);
    expect(btn.value.length).toBeLessThan(2000);
    expect((await decodeRemoteOffer(btn.value, "U1")).ok).toBe(true);
    expect((await decodeRemoteOffer(btn.value, "U2")).ok).toBe(false);
  });

  it("the modal has one input, names the server, and carries the offer", () => {
    const m = oauthPasteModal("svc", offer) as any;
    expect(m.callback_id).toBe(OAUTH_PASTE_VIEW);
    expect(m.blocks.filter((b: any) => b.type === "input")).toHaveLength(1);
    expect(JSON.stringify(m)).toContain("svc");
    expect(JSON.parse(m.private_metadata).u).toBe("U1");
  });

  it("reads the pasted value, trimmed", () => {
    expect(readOAuthPasteValue({ state: { values: { oauth_paste: { value: { value: "  http://x/cb?code=a&state=b  " } } } } })).toBe("http://x/cb?code=a&state=b");
    expect(readOAuthPasteValue({})).toBe("");
  });
});
