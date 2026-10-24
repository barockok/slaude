/**
 * How the helper (and the gateway's pre-flight/cleanup) reaches an environment:
 * a serialisable transport descriptor → an ssh2 socket and host check. Every
 * environment kind ends here; kinds differ only in the descriptor they build.
 */
import { createHash } from "node:crypto";
import { connect } from "node:net";
import type { SocketFactory } from "./conn";
import { tailcatSocket } from "./tailcat";

export type HelperTransport =
  /** tailcat SSH: the address embeds the server's WireGuard key, so the tunnel
   *  already authenticates the peer. */
  | { kind: "tailcat"; addr: string }
  /** Plain TCP with no host check: tests only. */
  | { kind: "tcp"; host: string; port: number }
  /** Plain SSH over TCP. `hostKey` is the pinned host key fingerprint
   *  ("SHA256:<base64>"), always checked; "" is accepted only by a pre-flight
   *  that is recording the pin (trust on first use). */
  | { kind: "ssh"; host: string; port: number; username: string; hostKey: string };

export interface ConnectInfo {
  transport: HelperTransport;
  privateKey: string;
}

/** OpenSSH-style fingerprint of a raw host public key blob. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function socketFor(t: HelperTransport): SocketFactory {
  if (t.kind === "tailcat") return tailcatSocket(t.addr);
  return () => connect(t.port, t.host);
}

/** The ssh2 host verifier a transport requires. `record` receives the presented
 *  fingerprint (pre-flight pinning). A pinned ssh transport accepts only its pin. */
export function hostVerifierFor(t: HelperTransport, record?: (fp: string) => void): (key: Buffer) => boolean {
  if (t.kind !== "ssh") return () => true;
  return (key) => {
    const fp = hostKeyFingerprint(key);
    record?.(fp);
    if (!t.hostKey) return !!record; // unpinned: only a recording pre-flight may proceed
    return fp === t.hostKey;
  };
}

export function usernameFor(t: HelperTransport): string | undefined {
  return t.kind === "ssh" ? t.username : undefined;
}
