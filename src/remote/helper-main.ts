/**
 * Remote helper subprocess: owns the transport (tailcat child or TCP socket), the SSH connection and the
 * private key, so none of them live in the agent process (spec §4.2).
 * Protocol: JSON lines on stdin/stdout. Exits when stdin closes.
 */
import { createInterface } from "node:readline";
import { RemoteConn } from "./conn";
import { hostVerifierFor, socketFor, usernameFor, type HelperTransport } from "./transport";
import { RemoteError } from "./types";

type Init = {
  t: "init";
  transport: HelperTransport;
  privateKey: string;
};

let conn: RemoteConn | null = null;
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.t === "init") {
    const i = msg as Init;
    conn = new RemoteConn({
      socket: socketFor(i.transport),
      privateKey: i.privateKey,
      username: usernameFor(i.transport),
      hostVerifier: hostVerifierFor(i.transport),
    });
    send({ t: "ready" });
    return;
  }
  if (msg.t === "exec") {
    if (!conn) return send({ t: "result", id: msg.id, ok: false, code: "INTERNAL", started: false, message: "helper not initialised" });
    conn.exec(msg.cmd, msg.opts).then(
      (res) => send({ t: "result", id: msg.id, ok: true, res }),
      (e) => send({
        t: "result", id: msg.id, ok: false,
        code: e instanceof RemoteError ? e.code : "INTERNAL",
        started: e instanceof RemoteError ? e.started : false,
        message: e instanceof RemoteError ? e.message.replace(/^[A-Z_]+: /, "") : String(e?.message ?? e),
      }),
    );
  }
});
rl.on("close", () => { conn?.close(); process.exit(0); });
