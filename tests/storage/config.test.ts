import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSyncStateDir, objectStore, resetObjectStore, s3Config, skillsMirror, storageMode, syncFlush, syncStateDir, LocalObjectStore } from "../../src/storage";

describe("storage config", () => {
  test("mode defaults to fs and rejects junk", () => {
    expect(storageMode({})).toBe("fs");
    expect(storageMode({ SLAUDE_STORAGE: "S3" })).toBe("s3");
    expect(() => storageMode({ SLAUDE_STORAGE: "nfs" })).toThrow("must be 'fs' or 's3'");
  });

  test("flush cadence defaults to turn and rejects junk", () => {
    expect(syncFlush({})).toBe("turn");
    expect(syncFlush({ SLAUDE_SYNC_FLUSH: "idle" })).toBe("idle");
    expect(() => syncFlush({ SLAUDE_SYNC_FLUSH: "never" })).toThrow("must be 'turn' or 'idle'");
  });

  test("the sync state directory is unset by default and must be an absolute path", () => {
    expect(syncStateDir({})).toBeNull();
    expect(syncStateDir({ SLAUDE_SYNC_STATE_DIR: "  " })).toBeNull();
    expect(syncStateDir({ SLAUDE_SYNC_STATE_DIR: "/var/lib/slaude-sync/" })).toBe("/var/lib/slaude-sync");
    expect(() => syncStateDir({ SLAUDE_SYNC_STATE_DIR: "relative/dir" })).toThrow("must be an absolute path");
  });

  test("a sync state directory is checked for writability at boot", () => {
    const ok = join(tmpdir(), `slaude-state-ok-${process.pid}-${Date.now()}`);
    checkSyncStateDir(ok);
    expect(existsSync(ok)).toBe(true);
    expect(readdirSync(ok)).toEqual([]); // the probe is removed
    rmSync(ok, { recursive: true, force: true });
    const file = join(tmpdir(), `slaude-state-file-${process.pid}-${Date.now()}`);
    writeFileSync(file, "x");
    expect(() => checkSyncStateDir(join(file, "sub"))).toThrow(/SLAUDE_SYNC_STATE_DIR .* is not writable/);
    rmSync(file, { force: true });
  });

  test("the skills mirror is on unless switched off", () => {
    expect(skillsMirror({})).toBe(true);
    expect(skillsMirror({ SLAUDE_SKILLS_MIRROR: "1" })).toBe(true);
    for (const off of ["0", "false", "no", "off", " OFF "]) expect(skillsMirror({ SLAUDE_SKILLS_MIRROR: off })).toBe(false);
    expect(() => skillsMirror({ SLAUDE_SKILLS_MIRROR: "maybe" })).toThrow("must be 1 or 0");
  });

  test("s3 config lists every missing required variable at once", () => {
    expect(() => s3Config({})).toThrow(/SLAUDE_S3_BUCKET, SLAUDE_S3_ACCESS_KEY_ID, SLAUDE_S3_SECRET_ACCESS_KEY/);
  });

  test("s3 config normalises endpoint and prefix, and defaults path style on for a custom endpoint", () => {
    const c = s3Config({
      SLAUDE_S3_ENDPOINT: "http://localhost:9000/",
      SLAUDE_S3_BUCKET: "b",
      SLAUDE_S3_PREFIX: "/prod/slaude/",
      SLAUDE_S3_ACCESS_KEY_ID: "k",
      SLAUDE_S3_SECRET_ACCESS_KEY: "s",
    });
    expect(c.endpoint).toBe("http://localhost:9000");
    expect(c.prefix).toBe("prod/slaude");
    expect(c.pathStyle).toBe(true);
    expect(c.region).toBe("us-east-1");
  });

  test("path style defaults off on the AWS endpoint and can be forced", () => {
    const base = { SLAUDE_S3_BUCKET: "b", SLAUDE_S3_ACCESS_KEY_ID: "k", SLAUDE_S3_SECRET_ACCESS_KEY: "s" };
    expect(s3Config(base).pathStyle).toBe(false);
    expect(s3Config({ ...base, SLAUDE_S3_PATH_STYLE: "1" }).pathStyle).toBe(true);
    expect(() => s3Config({ ...base, SLAUDE_S3_PATH_STYLE: "maybe" })).toThrow("must be 1 or 0");
  });

  test("objectStore is null in fs mode and a LocalObjectStore with the rehearsal dir", () => {
    resetObjectStore();
    expect(objectStore({})).toBeNull();
    expect(objectStore({ SLAUDE_STORAGE: "s3", SLAUDE_STORAGE_LOCAL_DIR: "/tmp/slaude-config-test" })).toBeInstanceOf(LocalObjectStore);
  });
});
