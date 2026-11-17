/**
 * A node's direct upload: the `upload` tool call, done in three steps so the
 * bytes go from this node straight to Slack and the gateway never reads a node
 * path or carries the file.
 *
 *   1. Check the file here: not a remote-environment turn, a regular file under
 *      the session's working directory or its scratch directory (see
 *      ./scratch), opened once, its size taken from the open descriptor.
 *   2. surface/upload_begin (gateway): the gateway asks Slack for a presigned
 *      URL. The node POSTs the bytes there, streamed from the descriptor, and
 *      CHECKS Slack's answer: HTTP 200 and `OK - <n>` with n the declared size.
 *      Slack's complete call succeeds even when no bytes arrived, so this check
 *      is the only proof the file is there.
 *   3. surface/upload_complete (gateway): only after that check, with the
 *      handle begin returned. The gateway judges the caption and finishes it.
 *
 * Slack's upload URL and the handle are credentials for one file. They are
 * never logged or put in an error or in the tool result.
 *
 * The read guard prevents mistakes (an agent naming the wrong path); it is not
 * a boundary against an agent that has a shell on this node and can write to
 * the scratch directory or the working directory itself.
 */
import { closeSync, createReadStream, existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { checkUploadUrl } from "../gateway/upload/url";
import { openConfinedFd } from "../gateway/core/confined-file";
import type { NodeClient, ToolResult } from "./client";
import { decodeClaims } from "./remote";

export interface UploadArgs {
  path: string;
  title?: string;
  initial_comment?: string;
  alt_text?: string;
}

export interface DirectUploadDeps {
  client: Pick<NodeClient, "uploadBegin" | "uploadComplete">;
  /** The session's current job token, read at each call: complete may run after a refresh. */
  tokenFor(): string | undefined;
  /** The session's working directory, or undefined when unknown. */
  workingDir(): Promise<string | undefined>;
  /** The session's scratch directory, or undefined when it has none. */
  scratchDir(): string | undefined;
  signal?: AbortSignal;
  /** Test seam: the fetch used for the POST to Slack. */
  fetchImpl?: typeof fetch;
}

export type DirectUploadOutcome = { result: ToolResult } | { fallback: "old-gateway" | "no-capability" };

const MAX_TITLE = 1024;
const MAX_ALT_TEXT = 4000;
/** How much of Slack's answer is read: `OK - <n>` is a few bytes. */
const ANSWER_BYTES = 512;

/** Whether `path`, with symlinks resolved as far as it exists, lies inside one of `roots`.
 *  A path that does not exist yet is judged by its nearest existing ancestor. */
function withinRoots(path: string, roots: readonly string[]): boolean {
  let probe = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = join(realpathSync(probe), ...rest);
      return roots.some((r) => {
        try {
          const root = realpathSync(r);
          return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
        } catch {
          return false;
        }
      });
    } catch {
      const up = dirname(probe);
      if (up === probe) return false;
      rest.unshift(basename(probe));
      probe = up;
    }
  }
}

/** Read at most `max` bytes of a response body, then drop the rest. */
async function readBounded(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } catch { /* an answer that breaks off is read as what arrived */ } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

const err = (text: string): { result: ToolResult } => ({ result: { content: [{ type: "text", text }], isError: true } });
const done = (): { result: ToolResult } => ({ result: { content: [{ type: "text", text: "uploaded" }] } });

export const REMOTE_REFUSAL =
  "upload refused: this session runs in a remote environment, so its files are on the user's machine and cannot be uploaded this way. Tell the user where the file is, or have them attach it themselves.";

const refusal = (path: string): string =>
  `upload refused: ${basename(path) || "file"} is not a regular file under this session's working directory or scratch directory ($TMPDIR). Copy the file into one of them and upload it from there.`;

/** Remove the URL and the handle from text that is about to be shown or logged. */
function scrub(textIn: string, secrets: readonly string[]): string {
  let out = textIn;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out;
}

/** The body's bytes, read from the checked descriptor, exactly `size` of them. A file
 *  that ends early (truncated in place) fails the stream, so Slack never sees a short body. */
function fileBody(fd: number, size: number): { body: ReadableStream<Uint8Array>; close: () => void } {
  const rs = createReadStream("", { fd, start: 0, end: size - 1, autoClose: true });
  async function* chunks() {
    let n = 0;
    for await (const c of rs) {
      n += (c as Buffer).length;
      yield c as Buffer;
    }
    if (n !== size) throw new Error("file changed while it was being read");
  }
  return { body: Readable.toWeb(Readable.from(chunks(), { objectMode: false })) as ReadableStream<Uint8Array>, close: () => rs.destroy() };
}

export async function directUpload(args: UploadArgs, deps: DirectUploadDeps): Promise<DirectUploadOutcome> {
  const token = deps.tokenFor();
  if (!token) return err("upload failed: no job token for this session");
  // A remote turn's files are on the user's machine: refuse before looking at any local path.
  if (decodeClaims(token)?.remote) return err(REMOTE_REFUSAL);

  const wd = await deps.workingDir().catch(() => undefined);
  const roots = [wd, deps.scratchDir()].filter((r): r is string => !!r);
  const candidate = isAbsolute(args.path) ? args.path : wd ? resolve(wd, args.path) : args.path;
  if (!isAbsolute(candidate)) return err(refusal(args.path));
  if (typeof args.title === "string" && args.title.length > MAX_TITLE) return err(`upload refused: the title is longer than ${MAX_TITLE} characters`);
  if (typeof args.alt_text === "string" && args.alt_text.length > MAX_ALT_TEXT) return err(`upload refused: the alt text is longer than ${MAX_ALT_TEXT} characters`);
  // Outside the allowed places is one refusal whether or not the path exists.
  if (!withinRoots(candidate, roots)) return err(refusal(candidate));
  if (!existsSync(candidate)) return err(`file not found on this node: ${args.path}`);

  let opened: ReturnType<typeof openConfinedFd>;
  try {
    opened = openConfinedFd(candidate, roots);
  } catch {
    // Not a regular file, or outside the allowed places (UploadRefusal), or a failed open.
    return err(refusal(candidate));
  }
  let fdOwned = true; // until a stream owns it
  try {
    if (opened.size === 0) return err(`upload refused: ${basename(candidate)} is empty and Slack does not take empty files`);

    const begun = await deps.client.uploadBegin(
      { filename: basename(candidate), size: opened.size, ...(args.alt_text ? { alt_text: args.alt_text } : {}) },
      token,
      deps.signal,
    );
    if (!begun.ok) {
      if (begun.unavailable) return { fallback: begun.unavailable };
      return err(begun.error);
    }
    const secrets = [begun.uploadUrl, begun.handle];
    // Checked again here: the gateway's answer is not trusted with where the bytes go.
    if (!checkUploadUrl(begun.uploadUrl)) {
      console.warn("[node] direct upload: refused an upload URL on an unexpected host");
      return err("upload refused: the upload address was not an expected Slack host. Nothing was sent.");
    }

    const file = fileBody(opened.fd, opened.size);
    fdOwned = false;
    let res: Response;
    try {
      res = await (deps.fetchImpl ?? fetch)(begun.uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(opened.size) },
        body: file.body,
        duplex: "half",
        // Bun's own 300 s limit would cut a large upload; the turn's abort is the limit.
        timeout: false,
        // The URL was checked above; a redirect would send the bytes somewhere unchecked.
        redirect: "error",
        ...(deps.signal ? { signal: deps.signal } : {}),
      } as RequestInit);
    } catch (e) {
      file.close();
      if (deps.signal?.aborted) return err("upload stopped: the turn was stopped");
      const msg = e instanceof Error ? e.message : String(e);
      if (/file changed/.test(msg) || /file changed/.test(String((e as { cause?: unknown })?.cause ?? ""))) {
        return err(`upload failed: ${basename(candidate)} changed while it was being sent. Nothing was posted; try again.`);
      }
      const code = typeof (e as { code?: unknown })?.code === "string" && /^[A-Z_]{3,40}$/.test((e as { code: string }).code) ? ` (${(e as { code: string }).code})` : "";
      console.warn("[node] direct upload: the transfer to Slack failed");
      return err(`upload failed: the connection to Slack broke while sending the file${code}. Nothing was posted; try again.`);
    }
    file.close();
    const answer = scrub(await readBounded(res, ANSWER_BYTES), secrets).trim();
    if (res.status !== 200) {
      console.warn(`[node] direct upload: Slack answered HTTP ${res.status}`);
      return err(`upload failed: Slack rejected the file (HTTP ${res.status}). Nothing was posted; try again.`);
    }
    const m = /^OK - (\d+)$/.exec(answer);
    if (!m) {
      console.warn("[node] direct upload: Slack's answer was not understood");
      return err("upload failed: Slack's answer to the file transfer was not understood. Nothing was posted; try again.");
    }
    if (Number(m[1]) !== opened.size) {
      console.warn("[node] direct upload: Slack stored a different byte count");
      return err(`upload failed: Slack stored ${m[1]} bytes but ${opened.size} were sent. Nothing was posted; try again.`);
    }

    // complete reads the token again: a held caption can outlast the one begin used.
    let done2: ToolResult;
    try {
      done2 = await deps.client.uploadComplete(
        { handle: begun.handle, ...(args.title ? { title: args.title } : {}), ...(args.initial_comment ? { initial_comment: args.initial_comment } : {}) },
        deps.tokenFor() ?? token,
        deps.signal,
      );
    } catch {
      // A network error or a non-200 from the gateway: never its raw message.
      console.warn("[node] direct upload: the gateway's complete call failed");
      if (deps.signal?.aborted) return err("upload stopped: the turn was stopped. The file reached Slack but was not posted.");
      return err("upload failed: the upload could not be completed. The file reached Slack but was not posted; try again.");
    }
    if (done2.isError) return err(scrub(done2.content[0]?.text ?? "upload failed", secrets));
    return done();
  } finally {
    if (fdOwned) {
      try { closeSync(opened.fd); } catch { /* already closed */ }
    }
  }
}
