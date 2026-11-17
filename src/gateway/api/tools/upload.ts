/**
 * upload_begin and upload_complete on the /v1 tool plane: the gateway's half
 * of a direct upload (the node sends the bytes straight to Slack). Both are
 * restOnly contract tools, so no model ever sees them; a node's `upload` shim
 * calls them in sequence around its own POST to Slack.
 *
 * begin    validates the declared size and name, asks Slack for a presigned
 *          URL with the persona's own client, and signs a handle that carries
 *          the destination from the job claims.
 * complete reads the destination back from the handle (never from the request
 *          body), judges the caption through the surface (the owner's reply
 *          rules, hold included) and finishes the file in Slack.
 *
 * The gateway never sees the bytes, so every size here is the declared one.
 * Slack's upload URL and the handle are credentials for one file: they are
 * never logged, audited or echoed outside the begin result.
 */
import { surfaceContract } from "../../../tools/contracts/surface";
import { parseToolArgs } from "../../../tools/contracts/types";
import { env } from "../../../config/env";
import { m as metric } from "../../../metrics";
import { emitAudit } from "../../../audit/emit";
import { redactSecrets } from "../../core/status-text";
import { OutboundRefusal } from "../../slack/outbound";
import { sanitizeFilename } from "../../upload/filename";
import { UPLOAD_BEGINS_PER_MINUTE, uploadLimiter } from "../../upload/limiter";
import { mintUploadHandle, verifyUploadHandle } from "../../upload/handle";
import { UPLOAD_SUPPRESSED } from "../../core/surface";
import type { JobClaims } from "../auth";
import type { ToolPlaneDeps, ToolResult } from "./deps";

const c = surfaceContract.tools;

export const UPLOAD_TOOL_NAMES: readonly string[] = [c.upload_begin.name, c.upload_complete.name];

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const count = (result: string): void => metric.uploadTotal.inc({ result });
const why = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e));

/** What the agent is told about a handle that did not verify. Never the handle. */
const HANDLE_REFUSALS: Record<string, string> = {
  expired: "the upload took longer than ten minutes between begin and complete",
  wrong_session: "the upload handle belongs to another session",
  unconfigured: "this gateway cannot verify upload handles",
};

export async function executeUploadTool(
  tool: string,
  body: unknown,
  claims: JobClaims,
  deps: ToolPlaneDeps,
): Promise<ToolResult | null> {
  if (tool === c.upload_begin.name) return begin(body, claims, deps);
  if (tool === c.upload_complete.name) return complete(body, claims, deps);
  return null;
}

async function begin(body: unknown, claims: JobClaims, deps: ToolPlaneDeps): Promise<ToolResult | null> {
  const a = parseToolArgs(c.upload_begin, body);
  const max = env.uploadMaxBytes();
  if (a.size > max) {
    count("too_large");
    return fail(`upload refused: the file is ${a.size} bytes, over the limit of ${max} bytes`);
  }
  const ctx = deps.slackCtx(claims);
  const surface = deps.surfaceFor(ctx);
  if (!surface.capabilities.has("upload") || !surface.uploadBegin) return null;
  const NOT_SENT = "upload not sent: the console is holding this session, so nothing the agent posts reaches Slack right now.";
  if (await surface.uploadHeld?.()) {
    count("suppressed");
    return fail(NOT_SENT);
  }
  if (!(await uploadLimiter().take(claims.session))) {
    count("rate_limited");
    return fail(`upload refused: at most ${UPLOAD_BEGINS_PER_MINUTE} uploads per minute per session. Wait a little and try again.`);
  }
  const filename = sanitizeFilename(a.filename);
  let begun: { uploadUrl: string; fileId: string };
  try {
    const got = await surface.uploadBegin({ filename, size: a.size, ...(a.alt_text ? { altText: a.alt_text } : {}) });
    if ("suppressed" in got) {
      count("suppressed");
      return fail(NOT_SENT);
    }
    begun = got;
  } catch (e) {
    count("begin_failed");
    return fail(`upload failed: ${why(e)}`);
  }
  const handle = mintUploadHandle({
    tenant: claims.tenant,
    persona: claims.persona,
    session: claims.session,
    team: claims.team,
    channel: claims.channel,
    thread: claims.thread,
    ...(claims.post === "channel" ? { post: "channel" as const } : {}),
    ...(claims.app ? { app: claims.app } : {}),
    fileId: begun.fileId,
    filename,
    size: a.size,
  });
  count("begun");
  return ok(JSON.stringify({ uploadUrl: begun.uploadUrl, fileId: begun.fileId, handle }));
}

async function complete(body: unknown, claims: JobClaims, deps: ToolPlaneDeps): Promise<ToolResult | null> {
  const a = parseToolArgs(c.upload_complete, body);
  const v = verifyUploadHandle(a.handle, claims);
  if (!v.ok) {
    count("bad_handle");
    return fail(`upload refused: the upload handle is not valid (${HANDLE_REFUSALS[v.reason] ?? "it was not issued by this gateway or was changed"}). Start the upload again.`);
  }
  const h = v.claims;
  // The destination is the handle's. The caller's claims supply who is calling and the turn's plumbing.
  const { post: _post, app: _app, ...rest } = claims;
  const dest: JobClaims = {
    ...rest,
    team: h.team,
    channel: h.channel,
    thread: h.thread,
    ...(h.post ? { post: h.post } : {}),
    ...(h.app ? { app: h.app } : {}),
  };
  const ctx = deps.slackCtx(dest);
  const surface = deps.surfaceFor(ctx);
  if (!surface.capabilities.has("upload") || !surface.uploadComplete) return null;
  try {
    const sent = await surface.uploadComplete({
      fileId: h.fileId,
      filename: h.filename,
      ...(a.title ? { title: a.title } : {}),
      ...(a.initial_comment ? { comment: a.initial_comment } : {}),
    });
    if (sent && "suppressed" in sent) {
      count("suppressed");
      return fail("upload not sent: the console is holding this session, so the file was not posted to Slack.");
    }
  } catch (e) {
    if (e instanceof OutboundRefusal) {
      count("refused");
      return fail(e.message);
    }
    count("complete_failed");
    return fail(`upload failed: ${why(e)}`);
  }
  count("completed");
  emitAudit({
    persona: h.persona,
    actorKind: "slack_user",
    actorId: claims.initiator || "unknown",
    action: "surface.upload",
    targetKind: "channel",
    targetId: h.channel,
    sessionId: h.session,
    channelId: h.channel,
    threadTs: h.thread || null,
    summary: `uploaded ${h.filename} (${h.size} bytes declared)`,
    details: { size: h.size, filename: h.filename, via: "direct" },
  });
  return ok(JSON.stringify({ ok: true, file_id: h.fileId }));
}
