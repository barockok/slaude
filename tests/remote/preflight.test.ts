import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { describePreflightFailure, preflight, remoteCleanup } from "../../src/remote/preflight";
import { startTestSshServer } from "./ssh-test-server";

const pair = utils.generateKeyPairSync("ed25519");
const stranger = utils.generateKeyPairSync("ed25519");
let srv: Awaited<ReturnType<typeof startTestSshServer>>;
const socket = () => connect(srv.port, "127.0.0.1");

beforeAll(async () => { srv = await startTestSshServer({ authorizedPublicKey: pair.public }); });
afterAll(async () => { await srv.stop(); });

describe("preflight", () => {
  it("resolves an absolute directory via pwd -P", async () => {
    const d = mkdtempSync(join(homedir(), ".slaude-pf-"));
    try {
      const r = await preflight({ addr: "x", dir: d, privateKey: pair.private, socket });
      expect(r).toEqual({ ok: true, dir: realpathSync(d) });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("expands ~/ under HOME", async () => {
    const d = mkdtempSync(join(homedir(), ".slaude-pf-"));
    try {
      const rel = d.slice(homedir().length + 1);
      const r = await preflight({ addr: "x", dir: `~/${rel}`, privateKey: pair.private, socket });
      expect(r).toEqual({ ok: true, dir: realpathSync(d) });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("reports a missing directory", async () => {
    const r = await preflight({ addr: "x", dir: "/nonexistent/slaude-dir", privateKey: pair.private, socket });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("directory not found");
  });

  it("reports a rejected key", async () => {
    const r = await preflight({ addr: "x", dir: "/", privateKey: stranger.private, socket });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("REMOTE_AUTH_FAILED");
  });
});

describe("describePreflightFailure", () => {
  it("maps a missing perl (exit 127) to a clear message, not 'directory not found'", () => {
    const m = describePreflightFailure({ code: 127, stdout: "", stderr: "sh: perl: command not found\n" }, "/r");
    expect(m).toContain("perl is required");
    expect(m).not.toContain("directory");
  });
  it("detects perl in stderr even with another exit code", () => {
    expect(describePreflightFailure({ code: 1, stdout: "", stderr: "bash: perl: not found" }, "/r")).toContain("perl is required");
  });
  it("a directory merely named perl-something is still a directory error", () => {
    expect(describePreflightFailure({ code: 1, stdout: "", stderr: "cd: /home/me/perl-app: No such file or directory" }, "/home/me/perl-app")).toContain("directory not found");
  });
  it("otherwise reports the directory", () => {
    expect(describePreflightFailure({ code: 1, stdout: "", stderr: "cd: no such file" }, "/r")).toBe("directory not found or not accessible: /r");
  });
});

describe("remoteCleanup", () => {
  it("removes the session's background dir under $HOME/.slaude-bg", async () => {
    const key = `pftest${process.pid}`;
    const dir = join(homedir(), ".slaude-bg", key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "deadbeef.log"), "x");
    try {
      await remoteCleanup({ addr: "x", privateKey: pair.private, sessionKey: key, socket });
      expect(existsSync(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15_000);

  it("never throws when the server is unreachable", async () => {
    const dead = () => connect(1, "127.0.0.1");
    await expect(remoteCleanup({ addr: "x", privateKey: pair.private, sessionKey: "abc", socket: dead })).resolves.toBeUndefined();
  });

  it("never throws on an unusable session key", async () => {
    await expect(remoteCleanup({ addr: "x", privateKey: pair.private, sessionKey: "///", socket })).resolves.toBeUndefined();
  });
});
