/**
 * POST /v1/jobs/:id/ack | /v1/jobs/:id/fail — node job telemetry (spec §3).
 * Accept + log + metric only; BullMQ owns job state.
 */
import { m as metric } from "../../metrics";
import { json, readJson } from "./http";

export async function handleJobEvent(req: Request, jobId: string, event: "ack" | "fail"): Promise<Response> {
  const body = await readJson(req);
  if (body === null) return json(400, { error: "malformed JSON body" });
  const detail = body && typeof body === "object" && Object.keys(body as object).length
    ? ` ${JSON.stringify(body)}`
    : "";
  if (event === "fail") console.warn(`[v1-jobs] fail job=${jobId}${detail}`);
  else console.log(`[v1-jobs] ack job=${jobId}${detail}`);
  metric.v1JobEventsTotal.inc({ event });
  return json(200, { ok: true });
}
