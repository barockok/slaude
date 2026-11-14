/**
 * Turn a parsed reference into the record it names (read only; creating is
 * `ensureBinding` / `ensureBoundary`). A reference to something not stored yet
 * resolves to nulls, not an error.
 */
import * as Domain from "../db/domain";
import type { DbClient } from "../db/schema";
import type { Ref } from "./types";

export interface ResolveCtx {
  /** The workspace a short Slack form (no `T.../`) means. */
  defaultWorkspace?: string;
  tx?: DbClient;
}

export type Resolved =
  | { kind: "user"; record: Domain.UserRow | null; binding: Domain.BindingRow | null }
  | { kind: "boundary"; record: Domain.BoundaryRow | null; binding: null }
  | { kind: "agent" | "env" | "node" | "selector"; record: null; binding: null };

export async function resolveRef(ref: Ref, ctx: ResolveCtx = {}): Promise<Resolved> {
  const tx = ctx.tx;
  const byBinding = async (key: Domain.BindingKey): Promise<Resolved> => {
    const binding = await Domain.findBinding(key, tx);
    return { kind: "user", record: binding ? await Domain.getUser(binding.user_id, tx) : null, binding };
  };
  const byBoundary = async (key: Domain.BoundaryKey): Promise<Resolved> => ({
    kind: "boundary",
    record: await Domain.findBoundary(key, tx),
    binding: null,
  });
  switch (ref.kind) {
    case "selector":
      return { kind: "selector", record: null, binding: null };
    case "email":
      return byBinding({ service: "email", kind: "address", workspace: "", value: ref.address });
    case "internal": {
      if (ref.type === "user") {
        const id = await Domain.resolveUserId(ref.id, tx);
        return { kind: "user", record: id ? await Domain.getUser(id, tx) : null, binding: null };
      }
      if (ref.type === "boundary") return { kind: "boundary", record: await Domain.getBoundary(ref.id, tx), binding: null };
      return { kind: ref.type, record: null, binding: null };
    }
    case "external": {
      if (ref.service === "slack") {
        const workspace = ref.workspace ?? ctx.defaultWorkspace;
        if (!workspace) throw new Error("a Slack reference without a workspace needs a default workspace");
        return ref.type === "user"
          ? byBinding({ service: "slack", kind: "user", workspace, value: ref.id })
          : byBoundary({ service: "slack", workspace, value: ref.id });
      }
      if (ref.type === "group") return byBoundary({ service: ref.service, workspace: "", value: ref.id });
      return byBinding({ service: ref.service, kind: ref.type, workspace: "", value: ref.id });
    }
  }
}
