import { Server, utils } from "ssh2";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { generateSshKeyPair } from "../../src/remote/keygen";

/** A parseable ed25519 pair in ssh2's `{ private, public }` shape. */
export function testKeyPair(comment = ""): { private: string; public: string } {
  const p = generateSshKeyPair(comment);
  return { private: p.privateKey, public: p.publicKey };
}

export async function startTestSshServer(opts: { authorizedPublicKey: string }) {
  const parsed = utils.parseKey(opts.authorizedPublicKey);
  if (parsed instanceof Error) throw parsed;
  const allowed = Array.isArray(parsed) ? parsed[0]! : parsed;
  const hostKey = testKeyPair().private;
  const clients = new Set<any>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    // The peer finished: close our side too. Under Bun on Linux a socket whose FIN
    // lands while a write is in flight emits 'end' but never 'close', and stop()
    // (net.Server.close) would wait for it forever. ssh2 exposes no public handle.
    client.on("end", () => (client as any)._sock?.destroy());
    client
      .on("authentication", (ctx) => {
        if (
          ctx.method === "publickey" &&
          ctx.key.algo === allowed.type &&
          timingSafeEqual(ctx.key.data, allowed.getPublicSSH()) &&
          (!ctx.signature || allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
        ) return ctx.accept();
        ctx.reject();
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            const ch = acceptExec();
            const p = spawn("/bin/sh", ["-c", info.command], { stdio: ["pipe", "pipe", "pipe"] });
            p.stdout.pipe(ch, { end: false });
            p.stderr.pipe(ch.stderr, { end: false });
            ch.pipe(p.stdin);
            p.on("close", (code) => {
              ch.exit(code ?? 255);
              ch.end();
            });
            // Channel closed by the client without a pty: like a real sshd, the
            // process is NOT killed here — that is what the pgid kill is for.
          });
        });
      })
      .on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    // net.Server.close waits for open connections; end them so "laptop went away" is immediate.
    stop: () => new Promise<void>((r) => {
      for (const c of clients) c.end();
      server.close(() => r());
    }),
  };
}
