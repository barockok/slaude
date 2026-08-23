/**
 * /v1/sessions/:id (spec §3 control plane). Job-token gated: the session id in
 * the path must equal the JWT's `session` claim — a node can only read/patch
 * the session its job is for.
 */
import { z } from "zod";
import * as Sessions from "../../db/sessions";
import type { SessionRow } from "../../db/schema";
import type { JobClaims } from "./auth";
import { json, notFound, readJson } from "./http";

const view = (row: SessionRow) => ({
  id: row.id,
  model: row.model,
  working_dir: row.working_dir,
  permission_mode: row.permission_mode,
  persona_id: row.persona_id,
  engaged: row.engaged,
  claude_started: row.claude_started,
  // Full-row parity for the node-side REST SessionStore (spec §6): the
  // AgentManager reads thread coordinates (channel mandate, /1on1 lookup),
  // status and timestamps off the same row shape the db repo returns.
  status: row.status,
  title: row.title,
  slack_team_id: row.slack_team_id,
  slack_channel_id: row.slack_channel_id,
  slack_thread_ts: row.slack_thread_ts,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const;

const patchSchema = z
  .object({
    claude_started: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    model: z.string().min(1).optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    /** Free-form short status ('idle' | 'running' today). */
    status: z.string().min(1).max(32).optional(),
  })
  .strict();

export async function handleSession(req: Request, id: string, claims: JobClaims): Promise<Response> {
  if (claims.session !== id) {
    return json(403, { error: "job token is not scoped to this session" });
  }
  const row = await Sessions.findById(id);
  if (!row) return notFound("session not found");

  if (req.method === "GET") return json(200, view(row));

  // PATCH
  const body = await readJson(req);
  if (body === null) return json(400, { error: "malformed JSON body" });
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return json(400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  const patch = parsed.data;
  if (patch.claude_started !== undefined) {
    if (patch.claude_started === true || patch.claude_started === 1) await Sessions.markStarted(id);
    else await Sessions.clearStarted(id);
  }
  if (patch.model !== undefined) await Sessions.setModel(id, patch.model);
  if (patch.permission_mode !== undefined) await Sessions.setPermissionMode(id, patch.permission_mode);
  if (patch.status !== undefined) await Sessions.setStatus(id, patch.status);
  return json(200, view((await Sessions.findById(id))!));
}
