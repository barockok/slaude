import { describe, it, expect } from "bun:test";
import { humanizeToolStatus } from "../../../src/gateway/core/status-text";

describe("humanizeToolStatus", () => {
  it("appends a remote marker without leaking args", () => {
    expect(humanizeToolStatus("Bash", { command: "curl -H 'Authorization: x' https://a" }, { remote: true })).toBe("running `curl` (remote)");
  });
});
