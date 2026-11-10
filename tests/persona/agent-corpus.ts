/**
 * A corpus of agent.yaml inputs and what the validator does with each, shared
 * by the acceptance test (the validator never accepts what it refused) and the
 * JSON Schema parity test (the editor schema agrees on the shape rules).
 *
 * `ok`: compileAgent accepts it. `shape`: for a refused case, whether the
 * refusal is a shape rule the JSON Schema must also express (a type, a key,
 * a pattern, a length). Rules that need more than the shape of one value (the
 * name matching its directory, a duplicate entry, an open code fence, a valid
 * regular expression, the YAML parser itself) are `shape: false`.
 */
import { stringify } from "yaml";

export interface CorpusCase {
  id: string;
  /** The YAML text. */
  yaml: string;
  ok: boolean;
  shape?: boolean;
}

type Doc = Record<string, unknown>;
const BASE: Doc = { name: "ana", soul: "You are Ana." };
const DIR = "ana";
export const CORPUS_DIR = DIR;

const cases: CorpusCase[] = [];
const toYaml = (patch: Doc) => {
  const d: Doc = { ...BASE, ...patch };
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return stringify(d, { lineWidth: 0 });
};
/** An accepted input. */
const ok = (id: string, patch: Doc) => void cases.push({ id, yaml: toYaml(patch), ok: true });
/** A refused input; `shape` false when only code, not the schema, can say no. */
const bad = (id: string, patch: Doc, shape = true) => void cases.push({ id, yaml: toYaml(patch), ok: false, shape });
const rawBad = (id: string, yaml: string, shape = false) => void cases.push({ id, yaml, ok: false, shape });
const rawOk = (id: string, yaml: string) => void cases.push({ id, yaml, ok: true });

const U = "U0EXAMPLE";
const C = "C0EXAMPLE";

// ---- accepted
ok("minimal", {});
ok("full", {
  description: "Handles support",
  model: "provider/model-name",
  slackUserId: U,
  userToken: "${PERSONA_ANA_XOXP}",
  provider: { apiKey: "env://PERSONA_ANA_KEY" },
  runsOn: "finance",
  mandate: { global: "Answer.", scoped: [{ boundary: `channel:${C}`, mode: "extend", text: "More." }, { boundary: "trust:public", mode: "reduce", text: "Less." }, { boundary: "dm", text: "Dm." }] },
  access: {
    manager: U, backupManager: "W0EXAMPLE",
    approvers: [{ user: U, scope: "budget", catchall: false }, { user: U, channel: C }],
    channels: { public: [C], trusted: ["G0EXAMPLE"] }, dm: [U], blocked: [U], redact: ["sk-[a-z]+"], approvalTimeoutSeconds: 120,
  },
  mcp: { mcpServers: { tracker: { type: "http", url: "https://tracker.example.com/mcp" } } },
  skills: ["release-notes"], guardrails: ["no-email"],
  memory: { kbSources: ["kb-handbook"], background: { budgetUsd: 2 } },
  channels: { [C]: { session: "channel", proactive: true } },
});
for (const k of ["description", "model", "slackUserId", "userToken", "provider", "runsOn", "mcp", "guardrails", "mandate", "access", "memory", "channels"]) ok(`null ${k}`, { [k]: null });
ok("empty strings", { description: "", model: "", userToken: "", runsOn: "" });
ok("description at the limit", { description: "x".repeat(2000) });
ok("numeric slackUserId", { slackUserId: 12345 });
ok("empty provider and mcp", { provider: {}, mcp: {} });
ok("skills empty", { skills: [] });
ok("skills slugs", { skills: ["a", "a-b", "0x"] });
ok("memory empty", { memory: {} });
ok("kbSources empty", { memory: { kbSources: [] } });
ok("background null", { memory: { background: null } });
ok("mandate empty", { mandate: {} });
ok("mandate null parts", { mandate: { global: null, scoped: null } });
ok("mandate global empty", { mandate: { global: "" } });
ok("scoped empty", { mandate: { scoped: [] } });
ok("scoped mode null", { mandate: { scoped: [{ boundary: "dm", mode: null, text: "x" }] } });
ok("scoped mode spaced and cased", { mandate: { scoped: [{ boundary: "dm", mode: " Extend ", text: "x" }] } });
ok("scoped mode unknown reads as extend", { mandate: { scoped: [{ boundary: "dm", mode: "bogus", text: "x" }] } });
ok("scoped mode number reads as extend", { mandate: { scoped: [{ boundary: "dm", mode: 5, text: "x" }] } });
ok("scoped long extend text", { mandate: { scoped: [{ boundary: "dm", mode: "extend", text: "x".repeat(900) }] } });
ok("access empty", { access: {} });
ok("access null parts", { access: { manager: null, backupManager: null, approvers: null, channels: null, dm: null, blocked: null, redact: null, approvalTimeoutSeconds: null } });
ok("approver user only", { access: { approvers: [{ user: U }] } });
ok("approver null parts", { access: { approvers: [{ user: U, scope: null, catchall: null, channel: null }] } });
ok("access channels null lists", { access: { channels: { public: null, trusted: null } } });
ok("access channels empty", { access: { channels: {} } });
ok("lists empty", { access: { dm: [], blocked: [], redact: [], channels: { public: [], trusted: [] } } });
ok("timeout zero", { access: { approvalTimeoutSeconds: 0 } });
ok("channels empty", { channels: {} });
ok("channel entry null", { channels: { [C]: null } });
ok("channel entry empty", { channels: { [C]: {} } });
ok("channel entry session", { channels: { [C]: { session: "channel" } } });
ok("channel entry proactive off", { channels: { [C]: { proactive: false } } });
ok("private and dm channel ids", { channels: { G0EXAMPLE: { proactive: true }, D0EXAMPLE: { proactive: false } } });

// ---- refused: top level
rawBad("not a mapping (list)", "- a\n- b\n");
rawBad("not a mapping (scalar)", "just text\n");
rawBad("empty file", "");
rawBad("duplicate key", "name: ana\nsoul: One.\nsoul: Two.\n");
bad("name mismatch", { name: "other" }, false);
bad("name number", { name: 5 }, true);
bad("name missing", { name: undefined }, true);
bad("name null", { name: null }, true);
bad("unknown top key", { extra: 1 });
bad("misspelt top key", { mandates: {} });
bad("soul missing", { soul: undefined });
bad("soul null", { soul: null });
bad("soul empty", { soul: "" });
bad("soul blank", { soul: "  \n " });
bad("soul number", { soul: 5 });
bad("soul list", { soul: ["a"] });
bad("description oversize", { description: "x".repeat(2001) });
bad("description number", { description: 5 });
bad("model number", { model: 5 });
bad("model list", { model: ["a"] });
bad("userToken number", { userToken: 5 });
bad("runsOn number", { runsOn: 5 });
bad("provider string", { provider: "x" });
bad("provider list", { provider: ["x"] });
bad("mcp string", { mcp: "x" });
bad("mcp list", { mcp: [] });
bad("skills null", { skills: null });
bad("skills string", { skills: "a" });
bad("skills map", { skills: {} });
bad("skills number entry", { skills: [1] });
bad("skills uppercase", { skills: ["Bad"] });
bad("skills underscore", { skills: ["a_b"] });
bad("skills empty entry", { skills: [""] });
bad("skills too long", { skills: ["a".repeat(65)] });
bad("skills null entry", { skills: [null] });
bad("skills duplicate", { skills: ["a", "a"] }, false);
bad("guardrails string", { guardrails: "a" });
bad("guardrails uppercase", { guardrails: ["Bad"] });
bad("guardrails too long", { guardrails: ["a".repeat(64)] });
bad("guardrails duplicate", { guardrails: ["a", "a"] }, false);
bad("memory string", { memory: "x" });
bad("memory list", { memory: [] });

// ---- memory
bad("memory unknown key", { memory: { extra: 1 } });
bad("kbSources null", { memory: { kbSources: null } });
bad("kbSources string", { memory: { kbSources: "kb" } });
bad("kbSources map", { memory: { kbSources: {} } });
bad("background string", { memory: { background: "x" } });
bad("background list", { memory: { background: [] } });

// ---- mandate
bad("mandate string", { mandate: "x" });
bad("mandate list", { mandate: [] });
bad("mandate unknown key", { mandate: { extra: 1 } });
bad("mandate global number", { mandate: { global: 5 } });
bad("mandate scoped string", { mandate: { scoped: "x" } });
bad("mandate scoped map", { mandate: { scoped: {} } });
bad("scoped entry string", { mandate: { scoped: ["x"] } });
bad("scoped entry null", { mandate: { scoped: [null] } });
bad("scoped entry unknown key", { mandate: { scoped: [{ boundary: "dm", text: "x", extra: 1 }] } });
bad("scoped boundary missing", { mandate: { scoped: [{ text: "x" }] } });
bad("scoped boundary null", { mandate: { scoped: [{ boundary: null, text: "x" }] } });
bad("scoped boundary number", { mandate: { scoped: [{ boundary: 5, text: "x" }] } });
bad("scoped boundary empty", { mandate: { scoped: [{ boundary: "", text: "x" }] } });
for (const b of ["channel:c0example", "channel:", "channel:X0EXAMPLE", "trust:other", "trust:", "DM", "dm ", "foo", "channel:C0EXAMPLE ", " dm", "dm\n"]) {
  bad(`scoped boundary pattern ${JSON.stringify(b)}`, { mandate: { scoped: [{ boundary: b, text: "x" }] } });
}
bad("scoped boundary repeated", { mandate: { scoped: [{ boundary: "dm", text: "x" }, { boundary: "dm", text: "y" }] } }, false);
bad("scoped text missing", { mandate: { scoped: [{ boundary: "dm" }] } });
bad("scoped text null", { mandate: { scoped: [{ boundary: "dm", text: null }] } });
bad("scoped text empty", { mandate: { scoped: [{ boundary: "dm", text: "" }] } });
bad("scoped text blank", { mandate: { scoped: [{ boundary: "dm", text: "  " }] } });
bad("scoped text number", { mandate: { scoped: [{ boundary: "dm", text: 5 }] } });

// ---- access
bad("access string", { access: "x" });
bad("access list", { access: [] });
bad("access unknown key", { access: { extra: 1 } });
bad("access misspelt key", { access: { approver: [] } });
for (const k of ["manager", "backupManager"]) {
  bad(`${k} number`, { access: { [k]: 5 } });
  bad(`${k} empty`, { access: { [k]: "" } });
  bad(`${k} lowercase`, { access: { [k]: "u0example" } });
  bad(`${k} channel id`, { access: { [k]: C } });
  bad(`${k} list`, { access: { [k]: [U] } });
}
bad("approvers string", { access: { approvers: "x" } });
bad("approvers map", { access: { approvers: {} } });
bad("approver string", { access: { approvers: ["x"] } });
bad("approver null", { access: { approvers: [null] } });
bad("approver unknown key", { access: { approvers: [{ user: U, extra: 1 }] } });
bad("approver user missing", { access: { approvers: [{ scope: "x" }] } });
bad("approver user null", { access: { approvers: [{ user: null }] } });
bad("approver user bad", { access: { approvers: [{ user: "bob" }] } });
bad("approver user empty", { access: { approvers: [{ user: "" }] } });
bad("approver scope empty", { access: { approvers: [{ user: U, scope: "" }] } });
bad("approver scope blank", { access: { approvers: [{ user: U, scope: "  " }] } });
bad("approver scope number", { access: { approvers: [{ user: U, scope: 5 }] } });
bad("approver catchall string", { access: { approvers: [{ user: U, catchall: "yes" }] } });
bad("approver catchall number", { access: { approvers: [{ user: U, catchall: 1 }] } });
bad("approver channel bad", { access: { approvers: [{ user: U, channel: "general" }] } });
bad("approver channel user id", { access: { approvers: [{ user: U, channel: U }] } });
bad("approver channel empty", { access: { approvers: [{ user: U, channel: "" }] } });
bad("approver channel number", { access: { approvers: [{ user: U, channel: 5 }] } });
bad("access.channels string", { access: { channels: "x" } });
bad("access.channels list", { access: { channels: [] } });
bad("access.channels unknown key", { access: { channels: { private: [C] } } });
bad("public string", { access: { channels: { public: C } } });
bad("public number entry", { access: { channels: { public: [1] } } });
bad("public bad entry", { access: { channels: { public: ["general"] } } });
bad("public user id entry", { access: { channels: { public: [U] } } });
bad("trusted bad entry", { access: { channels: { trusted: ["c0example"] } } });
bad("trusted null entry", { access: { channels: { trusted: [null] } } });
for (const k of ["dm", "blocked"]) {
  bad(`${k} string`, { access: { [k]: U } });
  bad(`${k} bad entry`, { access: { [k]: ["bob"] } });
  bad(`${k} channel entry`, { access: { [k]: [C] } });
  bad(`${k} number entry`, { access: { [k]: [1] } });
}
bad("redact string", { access: { redact: "x" } });
bad("redact empty entry", { access: { redact: [""] } });
bad("redact number entry", { access: { redact: [5] } });
bad("redact null entry", { access: { redact: [null] } });
bad("redact invalid regex", { access: { redact: ["("] } }, false);
bad("timeout negative", { access: { approvalTimeoutSeconds: -1 } });
bad("timeout fraction", { access: { approvalTimeoutSeconds: 1.5 } });
bad("timeout string", { access: { approvalTimeoutSeconds: "5" } });
bad("timeout bool", { access: { approvalTimeoutSeconds: true } });

// ---- channels
bad("channels string", { channels: "x" });
bad("channels list", { channels: [] });
bad("channels key lowercase", { channels: { c0example: {} } });
bad("channels key user id", { channels: { [U]: {} } });
bad("channels key name", { channels: { general: {} } });
bad("channel entry string", { channels: { [C]: "x" } });
bad("channel entry list", { channels: { [C]: [] } });
bad("channel entry unknown key", { channels: { [C]: { extra: 1 } } });
bad("channel entry misspelt key", { channels: { [C]: { proactiv: true } } });
bad("session thread", { channels: { [C]: { session: "thread" } } });
bad("session null", { channels: { [C]: { session: null } } });
bad("session bool", { channels: { [C]: { session: true } } });
bad("session cased", { channels: { [C]: { session: "Channel" } } });
bad("proactive string", { channels: { [C]: { proactive: "yes" } } });
bad("proactive null", { channels: { [C]: { proactive: null } } });
bad("proactive number", { channels: { [C]: { proactive: 1 } } });
bad("soul has own channel section", { soul: `Prose.\n\n## Channel <#${C}>\n### Session\n- Mode: channel\n`, channels: { [C]: { proactive: true } } }, false);
bad("soul ends in an open fence with channels", { soul: "Prose.\n```\ncode\n", channels: { [C]: { proactive: true } } }, false);
rawOk("quoted key style", `name: ana\nsoul: "You are Ana."\nchannels:\n  "${C}":\n    proactive: true\n`);

export const CORPUS: readonly CorpusCase[] = cases;
