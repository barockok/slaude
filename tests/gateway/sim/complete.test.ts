import { describe, it, expect } from "bun:test";
import { completeLine } from "../../../src/gateway/sim/complete";

const cands = ["/scenario", "/scenarios", "/state", "/as", "/1on1", "/ignore-thread", "/mode"];

describe("completeLine", () => {
  it("returns all candidates sharing the typed prefix", () => {
    expect(completeLine("/sc", cands)).toEqual(["/scenario", "/scenarios"]);
  });
  it("matches a single candidate", () => {
    expect(completeLine("/1", cands)).toEqual(["/1on1"]);
  });
  it("returns nothing once an argument is being typed (space present)", () => {
    expect(completeLine("/scenario 3", cands)).toEqual([]);
  });
  it("returns nothing for non-slash input", () => {
    expect(completeLine("hello", cands)).toEqual([]);
  });
  it("returns all commands for a bare slash", () => {
    expect(completeLine("/", cands)).toEqual(cands);
  });
  it("is empty when nothing matches", () => {
    expect(completeLine("/zzz", cands)).toEqual([]);
  });
});
