import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { shq, wrapCommand, isTailcatAddr, isRemoteDir, sanitizeKey, PGRP_MARKER, MTIME } from "../../src/remote/shell";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionConfigFp } from "../../src/remote/fingerprint";

const sh = (cmd: string) => spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" });

describe("shq", () => {
  for (const s of ["plain", "a b", "it's", "$(touch /tmp/x)", "`id`", "-rf", "semi;colon", "new\nline", "back\\slash", ""]) {
    it(`round-trips ${JSON.stringify(s)} literally`, () => {
      expect(sh(`printf %s ${shq(s)}`).stdout).toBe(s);
    });
  }
});

describe("MTIME", () => {
  it("prints a stable sub-second mtime that changes when the file's mtime does", () => {
    const dir = mkdtempSync(join(tmpdir(), "slaude-mtime-"));
    const f = join(dir, "f.txt");
    writeFileSync(f, "x");
    utimesSync(f, 1_700_000_000.25, 1_700_000_000.25);
    const a = sh(`${MTIME} ${shq(f)}`).stdout;
    expect(a).toBe(sh(`${MTIME} ${shq(f)}`).stdout);
    expect(a).toBe("1700000000.25");
    utimesSync(f, 1_700_000_000.5, 1_700_000_000.5);
    expect(sh(`${MTIME} ${shq(f)}`).stdout).toBe("1700000000.5");
  });
  it("prints nothing for a missing file", () => {
    expect(sh(`${MTIME} ${shq("/nonexistent/slaude-x")}`).stdout).toBe("");
  });
});

describe("wrapCommand", () => {
  it("runs the command in its own process group and prints the pgid marker on stderr", () => {
    const r = sh(wrapCommand("echo hi; echo err >&2", false));
    expect(r.stdout).toBe("hi\n");
    const m = r.stderr.match(new RegExp(`${PGRP_MARKER}(\\d+)`));
    expect(m).not.toBeNull();
    expect(r.stderr).toContain("err");
  });
  it("preserves the exit code", () => {
    expect(sh(wrapCommand("exit 7", false)).status).toBe(7);
  });
  it("login=true runs under bash -l", () => {
    expect(sh(wrapCommand("shopt -q login_shell && echo login", true)).stdout).toBe("login\n");
  });
});

describe("validators", () => {
  it("isTailcatAddr accepts addresses and DNS names, rejects flags and shell chars", () => {
    expect(isTailcatAddr("tcpGFwWCCEqTunZO94axBVxJ5xMNnoCc87SsBBqLUbCwCSZq_4N2Fr")).toBe(true);
    expect(isTailcatAddr("dev.example.com")).toBe(true);
    for (const bad of ["-o", "--serve", "a b", "x;y", "$(id)", "", "ab"]) expect(isTailcatAddr(bad)).toBe(false);
  });
  it("isRemoteDir accepts absolute and ~/ paths only", () => {
    expect(isRemoteDir("/home/a/repo")).toBe(true);
    expect(isRemoteDir("~/code/repo")).toBe(true);
    expect(isRemoteDir("~")).toBe(true);
    expect(isRemoteDir("/home/a/My Repo")).toBe(true);
    for (const bad of ["repo", "./repo", "/a\nb", "/a\0b", "", "/a\tb", "/a\x1bb", "/a`id`", "/a</remote-mode>b"]) expect(isRemoteDir(bad)).toBe(false);
  });
  it("sanitizeKey keeps only [A-Za-z0-9_-]", () => {
    expect(sanitizeKey("abc-123_X/../y z")).toBe("abc-123_Xyz");
    expect(sanitizeKey("ok_id-1")).toBe("ok_id-1");
    expect(sanitizeKey("../../etc")).toBe("etc");
  });
});

describe("sessionConfigFp", () => {
  it("is stable for equal input and changes with lock owner or target", () => {
    const a = sessionConfigFp("U1", { addr: "tcA", dir: "/r" });
    expect(sessionConfigFp("U1", { addr: "tcA", dir: "/r" })).toBe(a);
    expect(sessionConfigFp("U2", { addr: "tcA", dir: "/r" })).not.toBe(a);
    expect(sessionConfigFp("U1", { addr: "tcB", dir: "/r" })).not.toBe(a);
    expect(sessionConfigFp("U1", { addr: "tcA", dir: "/s" })).not.toBe(a);
    expect(sessionConfigFp("U1", null)).not.toBe(a);
    expect(sessionConfigFp(null, null)).toMatch(/^[0-9a-f]{16}$/);
  });
});
