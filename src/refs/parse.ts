/**
 * The typed reference grammar: parse, normalise and format.
 *
 *   internal   user:<id> boundary:<id> agent:<id> env:<id> node:<id>
 *   external   slack:user:<U|W id>   slack:channel:<C|G|D id>   (either may be T0.../<id>)
 *              whatsapp:phone:<E.164>  whatsapp:group:<id>  telegram:user:<digits>
 *   email      email:<address>
 *   selectors  trust:public  trust:trusted  dm   (a class of places, not one record)
 *
 * Case is not folded: the scheme and kind are lower case and Slack ids (and
 * workspaces) upper case already, or the reference is refused. Only an email
 * address is normalised (trimmed, lower-cased, domain folded).
 *
 * Each scheme fixes how many leading segments it has, so a `:` inside the last
 * segment needs no escaping. There is no percent-encoding and no empty segment.
 *
 * A `reason` is fixed text naming the problem; it never carries the input.
 * Every pattern is linear and the length is checked first, so hostile input
 * cannot hang or throw.
 */
import { domainToASCII } from "node:url";
import { CHANNEL_ID_SRC, USER_ID_SRC } from "./ids";
import { INTERNAL_KINDS, SELECTORS, SERVICES, type InternalKind, type ParseResult, type Ref, type RefRole, type SelectorName, type Service } from "./types";

export const REF_MAX = 256;
/** An email reference may carry its full 254-character address after `email:`. */
export const EMAIL_REF_MAX = REF_MAX + "email:".length - 2;
export const EMAIL_MAX = 254;

const WS = "T[A-Z0-9]+";
const INTERNAL_ID = "[A-Za-z0-9._-]{1,64}";
const PHONE = "\\+[1-9][0-9]{6,14}";
const GROUP_ID = "[A-Za-z0-9._@:-]{1,128}";
const TELEGRAM_ID = "[1-9][0-9]{0,19}";
const EMAIL_SHAPE = "[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+";

/** Pattern sources (no anchors) for the JSON Schema and the Zod schema; the parser is stricter. */
export const SRC = {
  slackUser: `slack:user:(?:${WS}/)?${USER_ID_SRC}`,
  slackChannel: `slack:channel:(?:${WS}/)?${CHANNEL_ID_SRC}`,
  whatsappPhone: `whatsapp:phone:${PHONE}`,
  whatsappGroup: `whatsapp:group:${GROUP_ID}`,
  telegramUser: `telegram:user:${TELEGRAM_ID}`,
  email: `email:${EMAIL_SHAPE}`,
  internalUser: `user:${INTERNAL_ID}`,
  internalBoundary: `boundary:${INTERNAL_ID}`,
  selector: "trust:(?:public|trusted)|dm",
  bareUser: USER_ID_SRC,
  bareChannel: CHANNEL_ID_SRC,
  legacyBoundary: `channel:${CHANNEL_ID_SRC}`,
};
/** Typed user references only. */
export const USER_REF_SRC = [SRC.slackUser, SRC.whatsappPhone, SRC.telegramUser, SRC.email, SRC.internalUser].join("|");
/** Typed channel references only. */
export const CHANNEL_REF_SRC = [SRC.slackChannel, SRC.whatsappGroup, SRC.internalBoundary].join("|");
/** A shape check that bounds the length first, so a regex over it stays small. */
export const anchored = (alts: string): string => `^(?=[\\s\\S]{1,${EMAIL_REF_MAX}}$)(?:${alts})$`;

const RE = {
  workspace: new RegExp(`^${WS}$`),
  slackUser: new RegExp(`^${USER_ID_SRC}$`),
  slackChannel: new RegExp(`^${CHANNEL_ID_SRC}$`),
  phone: new RegExp(`^${PHONE}$`),
  group: new RegExp(`^${GROUP_ID}$`),
  telegram: new RegExp(`^${TELEGRAM_ID}$`),
  internalId: new RegExp(`^${INTERNAL_ID}$`),
  // Control characters, format characters (zero-width, bidi) and every kind of space.
  blank: /[\p{Cc}\p{Cf}\p{Z}]/u,
  scheme: /^[A-Za-z]+$/,
  lower: /^[a-z]+$/,
  emailLocal: /^[a-z0-9!#$&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$&'*+/=?^_`{|}~-]+)*$/,
  emailLabel: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
};

const fail = (reason: string): ParseResult => ({ ok: false, reason });
const ok = (ref: Ref): ParseResult => ({ ok: true, ref });

export function refRole(ref: Ref): RefRole {
  switch (ref.kind) {
    case "email": return "user";
    case "selector": return "selector";
    case "internal": return ref.type === "user" ? "user" : ref.type === "boundary" ? "channel" : "other";
    case "external": return ref.type === "user" || ref.type === "phone" ? "user" : "channel";
  }
}

/** Parse and normalise one reference. `accept` limits the roles a field takes. */
export function parseRef(input: string, accept?: readonly RefRole[]): ParseResult {
  const r = parseAny(input);
  if (!r.ok || !accept) return r;
  const role = refRole(r.ref);
  if (!accept.includes(role)) {
    return fail(`reference is ${role === "other" ? "an agent, environment or node" : `a ${role}`} reference, but this field takes ${accept.join(" or ")}`);
  }
  return r;
}

function parseAny(input: unknown): ParseResult {
  if (typeof input !== "string") return fail("reference must be text");
  if (input.length === 0) return fail("reference is empty");
  const isEmail = input.startsWith("email:");
  if (input.length > (isEmail ? EMAIL_REF_MAX : REF_MAX)) return fail(isEmail ? `email address is longer than ${EMAIL_MAX} characters` : `reference is longer than ${REF_MAX} characters`);
  const first = input.indexOf(":");
  const head = first < 0 ? input : input.slice(0, first);
  if (first < 0) {
    return (SELECTORS as readonly string[]).includes(input) ? ok({ kind: "selector", name: input as SelectorName }) : fail("reference has no scheme (expected scheme:...)");
  }
  if (!RE.scheme.test(head)) return fail("reference scheme is not a known scheme");
  if (!RE.lower.test(head)) return fail("reference scheme and kind must be lower case");
  const scheme = head;
  if (scheme === "trust") {
    return (SELECTORS as readonly string[]).includes(input) ? ok({ kind: "selector", name: input as SelectorName }) : fail("selector must be trust:public, trust:trusted or dm");
  }
  if (scheme === "email") return parseEmail(input.slice(first + 1));
  if (input.includes("%")) return fail("reference must not use percent-encoding");
  if (RE.blank.test(input)) return fail("reference contains whitespace or control characters");
  const rest = input.slice(first + 1);
  if ((INTERNAL_KINDS as readonly string[]).includes(scheme)) return parseInternal(scheme as InternalKind, rest);
  if ((SERVICES as readonly string[]).includes(scheme)) return parseExternal(scheme as Service, rest);
  return fail("reference scheme is not a known scheme");
}

function parseInternal(type: InternalKind, rest: string): ParseResult {
  if (rest === "") return fail("reference has an empty segment");
  if (!RE.internalId.test(rest)) return fail("internal id must be 1 to 64 letters, digits, dot, underscore or hyphen");
  return ok({ kind: "internal", type, id: rest });
}

function parseExternal(service: Service, rest: string): ParseResult {
  const i = rest.indexOf(":");
  if (i < 0) return fail(rest === "" ? "reference has an empty segment" : "reference is missing its kind or id segment");
  const kindRaw = rest.slice(0, i);
  const id = rest.slice(i + 1);
  if (kindRaw === "" || id === "") return fail("reference has an empty segment");
  if (!RE.scheme.test(kindRaw)) return fail("reference kind is not valid for its scheme");
  if (!RE.lower.test(kindRaw)) return fail("reference scheme and kind must be lower case");
  const kind = kindRaw;
  if (service === "slack") {
    if (kind !== "user" && kind !== "channel") return fail("reference kind is not valid for its scheme");
    const slash = id.indexOf("/");
    let workspace: string | undefined;
    let bare = id;
    if (slash >= 0) {
      workspace = id.slice(0, slash);
      bare = id.slice(slash + 1);
      if (workspace === "" || bare === "") return fail("reference has an empty segment");
      if (!RE.workspace.test(workspace)) return fail("Slack workspace id must be T followed by upper-case letters and digits");
    }
    const upper = bare;
    if (!(kind === "user" ? RE.slackUser : RE.slackChannel).test(upper)) {
      return fail(kind === "user" ? "Slack user id must start with U or W, then upper-case letters and digits" : "Slack channel id must start with C, G or D, then upper-case letters and digits");
    }
    return ok({ kind: "external", service, type: kind, id: upper, ...(workspace ? { workspace } : {}) });
  }
  if (service === "whatsapp") {
    if (kind === "phone") return RE.phone.test(id) ? ok({ kind: "external", service, type: "phone", id }) : fail("phone must be E.164: + then 7 to 15 digits, not starting with 0");
    if (kind === "group") return RE.group.test(id) ? ok({ kind: "external", service, type: "group", id }) : fail("WhatsApp group id has characters outside letters, digits and . _ @ : -");
    return fail("reference kind is not valid for its scheme");
  }
  if (kind !== "user") return fail("reference kind is not valid for its scheme");
  return RE.telegram.test(id) ? ok({ kind: "external", service, type: "user", id }) : fail("Telegram user id must be digits, not starting with 0");
}

function parseEmail(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return fail("email address is empty");
  if (trimmed.length > EMAIL_MAX) return fail(`email address is longer than ${EMAIL_MAX} characters`);
  if (RE.blank.test(trimmed)) return fail("email address contains whitespace or control characters");
  if (/[<>"(),:;[\]\\%]/.test(trimmed)) return fail("email address must be a plain address, with no display name, brackets or quoting");
  const at = trimmed.indexOf("@");
  if (at < 0 || at !== trimmed.lastIndexOf("@")) return fail("email address must contain exactly one @");
  // The local part is checked as written, before any Unicode folding: a fullwidth
  // letter or the Kelvin sign is refused, never folded into ASCII. Only the domain is folded.
  const localRaw = trimmed.slice(0, at);
  const domainRaw = trimmed.slice(at + 1);
  if (localRaw === "") return fail("email address has an empty local part");
  if (domainRaw === "") return fail("email address has an empty domain");
  if (!/^[\x21-\x7e]+$/.test(localRaw)) return fail("email local part must be plain ASCII");
  const local = localRaw.toLowerCase();
  if (local.length > 64 || !RE.emailLocal.test(local)) return fail("email local part has characters or dots that are not allowed");
  const folded = domainRaw.normalize("NFKC").toLowerCase();
  if (!folded.includes(".")) return fail("email domain needs a dot");
  const domain = domainToASCII(folded);
  if (domain === "") return fail("email domain is not valid");
  if (domain.length > 253 || domain.length + 1 + local.length > EMAIL_MAX) return fail(`email address is longer than ${EMAIL_MAX} characters`);
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => RE.emailLabel.test(l))) return fail("email domain is not valid");
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return fail("email domain is not valid");
  return ok({ kind: "email", address: `${local}@${domain}` });
}

/** The canonical text of a reference. `parseRef(formatRef(r))` is `r`, and formatting is idempotent. */
export function formatRef(ref: Ref): string {
  switch (ref.kind) {
    case "internal": return `${ref.type}:${ref.id}`;
    case "external": return `${ref.service}:${ref.type}:${ref.workspace ? `${ref.workspace}/` : ""}${ref.id}`;
    case "email": return `email:${ref.address}`;
    case "selector": return ref.name;
  }
}

/** The scheme a reference is written with, for messages (never taken from input). */
export function refScheme(ref: Ref): string {
  switch (ref.kind) {
    case "internal": return ref.type;
    case "external": return ref.service;
    case "email": return "email";
    case "selector": return ref.name.startsWith("trust:") ? "trust" : "dm";
  }
}
