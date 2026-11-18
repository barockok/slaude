import { describe, expect, test } from "bun:test";
import { S3ObjectStore, StorageError, storageSelfCheck } from "../../src/storage";
import { runContract } from "./contract";

/**
 * Runs against any S3-compatible endpoint. Locally:
 *   docker compose -f docker-compose.s3-test.yaml up -d --wait
 *   SLAUDE_S3_TEST_ENDPOINT=http://localhost:9100 bun test tests/storage
 * Skipped without SLAUDE_S3_TEST_ENDPOINT.
 */
const endpoint = process.env.SLAUDE_S3_TEST_ENDPOINT;
const cfg = {
  endpoint: endpoint ?? "",
  region: "us-east-1",
  bucket: process.env.SLAUDE_S3_TEST_BUCKET ?? "slaude-test",
  prefix: `contract-${Date.now()}`,
  pathStyle: true,
  accessKeyId: process.env.SLAUDE_S3_TEST_ACCESS_KEY_ID ?? "slaude-test",
  secretAccessKey: process.env.SLAUDE_S3_TEST_SECRET_ACCESS_KEY ?? "slaude-test-secret",
};

if (!endpoint) {
  describe.skip("S3ObjectStore (set SLAUDE_S3_TEST_ENDPOINT)", () => test("skipped", () => {}));
} else {
  runContract("S3ObjectStore", () => new S3ObjectStore(cfg));

  describe("S3ObjectStore specifics", () => {
    test("the key prefix isolates two stores on one bucket", async () => {
      const a = new S3ObjectStore({ ...cfg, prefix: `${cfg.prefix}/a` });
      const b = new S3ObjectStore({ ...cfg, prefix: `${cfg.prefix}/b` });
      await a.put("k", new TextEncoder().encode("a"));
      expect(await b.head("k")).toBeNull();
      expect((await a.head("k"))?.size).toBe(1);
    });

    test("the self-check passes on a working endpoint", async () => {
      await storageSelfCheck(new S3ObjectStore(cfg), "unit");
    });

    test("the self-check names the failing operation on a bad bucket", async () => {
      const bad = new S3ObjectStore({ ...cfg, bucket: "no-such-bucket-slaude" });
      const err = await storageSelfCheck(bad, "unit").then(() => null, (e) => e);
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).message).toContain("self-check failed");
    });
  });
}
