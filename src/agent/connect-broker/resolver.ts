import type { ConnectionRow, ConnectionGrantRow } from "../../db/schema";
import type { ThreadKey } from "../../db/connections";
import { toolFlags } from "./registry";

export type ResolverDeps = {
  findOwn: (caller: string, service: string, t: ThreadKey) => ConnectionRow | null;
  findBorrowCandidate: (caller: string, service: string, t: ThreadKey) => ConnectionRow | null;
  findSlaude: (service: string) => ConnectionRow | null;
  findActiveGrant: (connectionId: string, borrower: string) => ConnectionGrantRow | null;
};

export type ResolveInput = { caller: string; service: string; tool: string; thread: ThreadKey };

export type ResolveResult =
  | { kind: "own"; connection: ConnectionRow }
  | { kind: "borrow_granted"; connection: ConnectionRow }
  | { kind: "needs_approval"; connection: ConnectionRow }
  | { kind: "slaude"; connection: ConnectionRow }
  | { kind: "needs_connect" }
  | { kind: "denied"; reason: string };

export function resolveConnection(input: ResolveInput, deps: ResolverDeps): ResolveResult {
  const flags = toolFlags(input.service, input.tool);

  // 1. Caller's own connection always wins.
  const own = deps.findOwn(input.caller, input.service, input.thread);
  if (own) return { kind: "own", connection: own };

  // 2. Try borrowing another member's connection.
  const candidate = deps.findBorrowCandidate(input.caller, input.service, input.thread);
  if (candidate) {
    if (!flags.borrowable) {
      return { kind: "denied", reason: `\`${input.tool}\` is owner-only and cannot be borrowed.` };
    }
    const grant = deps.findActiveGrant(candidate.id, input.caller);
    return grant
      ? { kind: "borrow_granted", connection: candidate }
      : { kind: "needs_approval", connection: candidate };
  }

  // 3. Personal tools never silently use slaude's identity.
  if (!flags.personal) {
    const slaude = deps.findSlaude(input.service);
    if (slaude) return { kind: "slaude", connection: slaude };
  }

  // 4. Nothing usable.
  return { kind: "needs_connect" };
}
