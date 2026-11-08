/**
 * Registry ids on SDK hook callbacks. The guardrail registry
 * (./guardrails.ts) describes every hook the runtime wires; the places that
 * wire them (agent/manager.ts, background/runner.ts) keep building their own
 * hooks and only mark each callback with its id here. The agreement test walks
 * a session's `options.hooks` and reads these marks back, so the registry
 * cannot drift from what runs.
 *
 * Marking never changes a hook: `tagHook` returns the very callback it was
 * given (same function object, so the same return values, `this` binding,
 * order and matchers), and the mark lives in a WeakMap beside it.
 */

/** Every hook id the runtime wires, by where it is wired. */
export const HOOK_IDS = {
  preCompact: "obs.pre-compact.compacting",
  stopMustReply: "hook.stop.must-reply",
  userPromptSuppress: "hook.user-prompt.suppress",
  remoteDenyLocal: "hook.pre-tool.remote-deny-local",
  skillGate: "hook.pre-tool.skill-gate",
  profileWriteGuard: "hook.pre-tool.profile-write-guard",
  skillGateMark: "hook.post-tool.skill-gate-mark",
  skillUsage: "obs.post-tool.skill-usage",
  passEndsTurn: "hook.post-tool.pass-ends-turn",
  backgroundOnlyPassTools: "hook.pre-tool.background-only-pass-tools",
} as const;

export type HookId = (typeof HOOK_IDS)[keyof typeof HOOK_IDS];

const tags = new WeakMap<object, string>();

/**
 * Mark `cb` with its registry id and return it unchanged. A callback that is
 * already marked (a module-level hook reused by every session) keeps its first
 * id; a different id for the same function is a wiring mistake the agreement
 * test reports, never a reason to fail a session boot.
 */
export function tagHook<T extends object>(id: HookId, cb: T): T {
  if (!tags.has(cb)) tags.set(cb, id);
  return cb;
}

/** The registry id a hook callback was marked with, or undefined. */
export function hookTag(cb: unknown): string | undefined {
  return typeof cb === "function" || (typeof cb === "object" && cb !== null) ? tags.get(cb as object) : undefined;
}
