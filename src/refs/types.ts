/** A typed reference to a user, a boundary (channel, group) or another domain object. See parse.ts. */
export const INTERNAL_KINDS = ["user", "boundary", "agent", "env", "node"] as const;
export type InternalKind = (typeof INTERNAL_KINDS)[number];

export const SERVICES = ["slack", "whatsapp", "telegram"] as const;
export type Service = (typeof SERVICES)[number];

export const SELECTORS = ["trust:public", "trust:trusted", "dm"] as const;
export type SelectorName = (typeof SELECTORS)[number];

export type Ref =
  | { kind: "internal"; type: InternalKind; id: string }
  | { kind: "external"; service: Service; type: "user" | "channel" | "phone" | "group"; id: string; workspace?: string }
  | { kind: "email"; address: string }
  | { kind: "selector"; name: SelectorName };

/**
 * What a reference denotes, for checking it against the field it sits in.
 * `user`: a person (Slack user, email, phone, Telegram id, internal user).
 * `channel`: a place (Slack channel, WhatsApp group, internal boundary).
 * `selector`: a class of places, not one record. `other`: agent, env, node.
 */
export type RefRole = "user" | "channel" | "selector" | "other";

export type ParseResult = { ok: true; ref: Ref } | { ok: false; reason: string };
