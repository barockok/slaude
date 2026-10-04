import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IdentityList } from "../../../src/gateway/portal/web/app/App";
import { api } from "../../../src/gateway/portal/web/app/api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ids = [
  { teamId: "T1", slackUserId: "U1", linkedAt: 1 },
  { teamId: "T2", slackUserId: "U2", linkedAt: 2 },
];

/** Walk a React element tree (function components already expanded) for nodes. */
function find(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((n) => find(n, pred, out));
    return out;
  }
  if (pred(node)) out.push(node);
  find(node.props?.children, pred, out);
  return out;
}

describe("portal Unlink button", () => {
  test("renders one Unlink button per Slack identity", () => {
    const html = renderToStaticMarkup(<IdentityList identities={ids} busy={null} onUnlink={() => {}} />);
    expect(html.match(/Unlink/g)?.length).toBe(2);
    expect(html).toContain("U1");
    expect(html).toContain("U2");
  });

  test("clicking Unlink hands that identity's team and user to the handler", () => {
    const calls: Array<[string, string]> = [];
    const tree = IdentityList({ identities: ids, busy: null, onUnlink: (t, u) => calls.push([t, u]) });
    const buttons = find(tree, (n) => n.type === "button");
    expect(buttons.length).toBe(2);
    buttons[1].props.onClick();
    expect(calls).toEqual([["T2", "U2"]]);
  });

  test("the in-flight identity's button is disabled", () => {
    const tree = IdentityList({ identities: ids, busy: "T1:U1", onUnlink: () => {} });
    const buttons = find(tree, (n) => n.type === "button");
    expect(buttons.map((b) => b.props.disabled)).toEqual([true, false]);
  });

  test("api.unlink is a DELETE with a JSON body and the CSRF header", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;
    await api.unlink("T1", "U1");
    expect(seen!.url).toBe("/portal/api/link");
    expect(seen!.init.method).toBe("DELETE");
    const h = seen!.init.headers as Record<string, string>;
    expect(h["x-portal-csrf"]).toBe("1");
    expect(h["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ teamId: "T1", slackUserId: "U1" });
  });
});
