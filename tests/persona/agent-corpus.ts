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
  /** An accepted case: the field paths that get a warning, exactly (each once). Left out: warnings are not checked. */
  warns?: string[];
  /** A refused case: text the message must contain (a field path, a scheme). */
  msgs?: string[];
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
const ok = (id: string, patch: Doc, warns?: string[]) => void cases.push({ id, yaml: toYaml(patch), ok: true, ...(warns ? { warns } : {}) });
/** A refused input; `shape` false when only code, not the schema, can say no. */
const bad = (id: string, patch: Doc, shape = true, msgs?: string[]) => void cases.push({ id, yaml: toYaml(patch), ok: false, shape, ...(msgs ? { msgs } : {}) });
const rawBad = (id: string, yaml: string, shape = false) => void cases.push({ id, yaml, ok: false, shape });
const rawOk = (id: string, yaml: string) => void cases.push({ id, yaml, ok: true });

const U = "U0EXAMPLE";
const C = "C0EXAMPLE";
const SU = `slack:user:${U}`;
const SC = `slack:channel:${C}`;

// ---- accepted
ok("minimal", {});
ok("full", {
  description: "Handles support",
  model: "provider/model-name",
  slackUserId: SU,
  userToken: "${PERSONA_ANA_XOXP}",
  provider: { apiKey: "env://PERSONA_ANA_KEY" },
  runsOn: "finance",
  mandate: { global: "Answer.", scoped: [{ boundary: SC, mode: "extend", text: "More." }, { boundary: "trust:public", mode: "reduce", text: "Less." }, { boundary: "dm", text: "Dm." }] },
  access: {
    manager: SU, backupManager: "slack:user:W0EXAMPLE",
    approvers: [{ user: SU, scope: "budget", catchall: false }, { user: SU, channel: SC }],
    channels: { public: [SC], trusted: ["slack:channel:G0EXAMPLE"] }, dm: [SU], blocked: [SU], redact: ["sk-[a-z]+"], approvalTimeoutSeconds: 120,
  },
  mcp: { mcpServers: { tracker: { type: "http", url: "https://tracker.example.com/mcp" } } },
  skills: ["release-notes"], guardrails: ["no-email"],
  memory: { kbSources: ["kb-handbook"], background: { budgetUsd: 2 } },
  channels: { [SC]: { session: "channel", proactive: true } },
}, []);
ok("full, bare legacy ids", {
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
}, ["slackUserId", "mandate.scoped[0].boundary", "access.manager", "access.backupManager", "access.approvers[0].user", "access.approvers[1].user", "access.approvers[1].channel", "access.channels.public[0]", "access.channels.trusted[0]", "access.dm[0]", "access.blocked[0]", `channels.${C}`]);
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



// ---- typed references, field by field
type RefField = {
  id: string;
  role: "user" | "channel";
  path: string;
  /** The patch that puts `v` in the field. */
  at: (v: string) => Doc;
};
const REF_FIELDS: RefField[] = [
  { id: "slackUserId", role: "user", path: "slackUserId", at: (v) => ({ slackUserId: v }) },
  { id: "manager", role: "user", path: "access.manager", at: (v) => ({ access: { manager: v } }) },
  { id: "backupManager", role: "user", path: "access.backupManager", at: (v) => ({ access: { backupManager: v } }) },
  { id: "approver user", role: "user", path: "access.approvers[0].user", at: (v) => ({ access: { approvers: [{ user: v }] } }) },
  { id: "approver channel", role: "channel", path: "access.approvers[0].channel", at: (v) => ({ access: { approvers: [{ user: SU, channel: v }] } }) },
  { id: "public", role: "channel", path: "access.channels.public[0]", at: (v) => ({ access: { channels: { public: [v] } } }) },
  { id: "trusted", role: "channel", path: "access.channels.trusted[0]", at: (v) => ({ access: { channels: { trusted: [v] } } }) },
  { id: "dm", role: "user", path: "access.dm[0]", at: (v) => ({ access: { dm: [v] } }) },
  { id: "blocked", role: "user", path: "access.blocked[0]", at: (v) => ({ access: { blocked: [v] } }) },
  { id: "channels key", role: "channel", path: "channels.", at: (v) => ({ channels: { [v]: {} } }) },
  { id: "scoped boundary", role: "channel", path: "mandate.scoped[0].boundary", at: (v) => ({ mandate: { scoped: [{ boundary: v, text: "x" }] } }) },
];
const OWN: Record<"user" | "channel", { typed: string[]; bare: string; other: string; wrongKind: string[]; unresolvable: string[] }> = {
  user: {
    typed: [SU, "slack:user:W0EXAMPLE", "slack:user:T0EXAMPLE/U0EXAMPLE"],
    bare: U,
    other: SC,
    wrongKind: [SC, "slack:channel:T0EXAMPLE/C0EXAMPLE", "boundary:room1", "whatsapp:group:g1", "agent:ana", "env:sandbox", "node:n1", "trust:public", "dm"],
    unresolvable: ["email:a@example.com", "email:a+x@example.com", "user:abc", "whatsapp:phone:+620000000000", "telegram:user:12345"],
  },
  channel: {
    typed: [SC, "slack:channel:G0EXAMPLE", "slack:channel:D0EXAMPLE", "slack:channel:T0EXAMPLE/C0EXAMPLE"],
    bare: C,
    other: SU,
    wrongKind: [SU, "slack:user:T0EXAMPLE/U0EXAMPLE", "user:abc", "email:a@example.com", "whatsapp:phone:+620000000000", "telegram:user:12345", "agent:ana", "env:sandbox", "node:n1", "trust:public", "dm"],
    unresolvable: ["boundary:room1", "whatsapp:group:g1"],
  },
};
const SCHEME_OF = (v: string) => v.split(":")[0]!;
for (const f of REF_FIELDS) {
  const own = OWN[f.role];
  const isKey = f.id === "channels key";
  const isBoundary = f.id === "scoped boundary";
  for (const v of own.typed) ok(`${f.id}: typed ${v}`, f.at(v), []);
  if (isBoundary) {
    ok(`${f.id}: selectors need no warning`, { mandate: { scoped: [{ boundary: "trust:public", text: "x" }, { boundary: "trust:trusted", text: "x" }, { boundary: "dm", text: "x" }] } }, []);
    ok(`${f.id}: legacy channel:<id> warns`, f.at(`channel:${C}`), [f.path]);
  } else {
    ok(`${f.id}: bare legacy id warns`, f.at(own.bare), [isKey ? `channels.${own.bare}` : f.path]);
  }
  const wrong = isBoundary || isKey ? own.wrongKind.filter((v) => !(isBoundary && (v === "trust:public" || v === "dm"))) : own.wrongKind;
  for (const v of wrong) {
    // A selector is not a reference to one record: refused in every field but a boundary.
    if (isKey && (v === "trust:public" || v === "dm")) continue;
    // slackUserId's bare form is any text without a colon, so a lone `dm` is a (warned) bare id there.
    if (f.id === "slackUserId" && v === "dm") continue;
    bad(`${f.id}: wrong kind ${v}`, f.at(v));
  }
  for (const v of own.unresolvable) {
    bad(`${f.id}: ${v} parses but cannot be resolved yet`, f.at(v), false, isKey ? ["cannot be resolved yet", `'${SCHEME_OF(v)}'`] : [f.path, `'${SCHEME_OF(v)}'`, "cannot be resolved yet"]);
  }
  for (const v of [`${f.role === "user" ? "slack:user" : "slack:channel"}:`, `${f.role === "user" ? "slack:user" : "slack:channel"}:T0EXAMPLE/`, `${f.role === "user" ? "slack:user" : "slack:channel"}:${f.role === "user" ? C : U}`, `${own.typed[0]} `, ` ${own.typed[0]}`, `${own.typed[0]}\n`, `${own.typed[0]}:x`, `x${own.typed[0]}`]) {
    bad(`${f.id}: malformed ${JSON.stringify(v)}`, f.at(v));
  }
}
// Users that only code can refuse (shape fine, address not).
for (const f of REF_FIELDS.filter((x) => x.role === "user")) {
  bad(`${f.id}: email with a double dot`, f.at("email:a..b@example.com"), false, [f.path]);
  bad(`${f.id}: email domain with a bare hyphen label`, f.at("email:a@-example.com"), false, [f.path]);
  bad(`${f.id}: email without a dot in the domain`, f.at("email:a@example"));
  bad(`${f.id}: email with two @`, f.at("email:a@@example.com"));
  bad(`${f.id}: email with a display name`, f.at("email:Ana <a@example.com>"));
  bad(`${f.id}: phone without a plus`, f.at("whatsapp:phone:620000000000"));
}
bad("slackUserId: a channel reference", { slackUserId: SC });
bad("slackUserId: a typed email is refused at compile", { slackUserId: "email:a@example.com" }, false, ["slackUserId", "'email'", "cannot be resolved yet"]);
ok("slackUserId: typed with a workspace", { slackUserId: "slack:user:T0EXAMPLE/U0EXAMPLE" }, []);
bad("scoped boundary: a typed duplicate of the legacy form", { mandate: { scoped: [{ boundary: `channel:${C}`, text: "x" }, { boundary: SC, text: "y" }] } }, false, ["mandate.scoped[1].boundary", "repeats"]);
bad("scoped boundary: a workspace form duplicates the plain one", { mandate: { scoped: [{ boundary: SC, text: "x" }, { boundary: `slack:channel:T0EXAMPLE/${C}`, text: "y" }] } }, false, ["mandate.scoped[1].boundary", "repeats"]);
bad("channels key: a typed and a bare key for one channel", { channels: { [SC]: {}, [C]: {} } }, false, ["repeats an earlier channel"]);
ok("channels key: two different channels", { channels: { [SC]: {}, "slack:channel:G0EXAMPLE": {} } }, []);
ok("access: typed everywhere, no warning", { slackUserId: SU, access: { manager: SU, dm: [SU], channels: { public: [SC] }, approvers: [{ user: SU, channel: SC }] }, channels: { [SC]: { proactive: true } } }, []);
ok("access: a mix of typed and bare warns for the bare ones only", { access: { manager: SU, backupManager: U, dm: [SU, U] } }, ["access.backupManager", "access.dm[1]"]);

// ---- refused: id, channel and boundary patterns at their edges
const USER_EDGES = ["U", "W", "u0example", "U-x", "U0EX AMPLE", "U0EXAMPLE\n", " U0EXAMPLE", "C0EXAMPLE", "U0EXAMPLE-1", "UABC_D"];
const CHAN_EDGES = ["C", "D", "G", "c0example", "CABC-x", "CABC\n", "C0EXAMPLE ", "U0EXAMPLE", "C0EXAMPLE_1", "X0EXAMPLE"];
for (const v of USER_EDGES) {
  bad(`manager edge ${JSON.stringify(v)}`, { access: { manager: v } });
  bad(`backupManager edge ${JSON.stringify(v)}`, { access: { backupManager: v } });
  bad(`approver user edge ${JSON.stringify(v)}`, { access: { approvers: [{ user: v }] } });
  bad(`dm edge ${JSON.stringify(v)}`, { access: { dm: [v] } });
  bad(`blocked edge ${JSON.stringify(v)}`, { access: { blocked: [v] } });
}
for (const v of CHAN_EDGES) {
  bad(`public edge ${JSON.stringify(v)}`, { access: { channels: { public: [v] } } });
  bad(`trusted edge ${JSON.stringify(v)}`, { access: { channels: { trusted: [v] } } });
  bad(`approver channel edge ${JSON.stringify(v)}`, { access: { approvers: [{ user: U, channel: v }] } });
  bad(`channels key edge ${JSON.stringify(v)}`, { channels: { [v]: {} } });
  bad(`boundary channel edge ${JSON.stringify(v)}`, { mandate: { scoped: [{ boundary: `channel:${v}`, text: "x" }] } });
}
for (const b of ["trust:private", "dm:x", "channel:C", "channel:C0EXAMPLE\n", "trust:public\n", "trust:publicx", "xtrust:public", "channel:C0-EXAMPLE", "channel"]) {
  bad(`boundary edge ${JSON.stringify(b)}`, { mandate: { scoped: [{ boundary: b, text: "x" }] } });
}
ok("single-letter-plus-one ids", { access: { manager: "U0", backupManager: "W1", dm: ["U1"], blocked: ["W9"], channels: { public: ["C1"], trusted: ["D1", "G1"] } }, channels: { C1: {} } });
bad("slackUserId list", { slackUserId: ["a"] });
bad("slackUserId map", { slackUserId: { a: 1 } });
bad("slackUserId bool", { slackUserId: true });
rawBad("slackUserId deeply nested", `name: ana\nsoul: x\nslackUserId: ${"[".repeat(5000)}${"]".repeat(5000)}\n`, true);
bad("kbSources number entry", { memory: { kbSources: [1] } });
bad("kbSources null entry", { memory: { kbSources: [null] } });
bad("kbSources map entry", { memory: { kbSources: [{}] } });

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
