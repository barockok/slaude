import { describe, it, expect } from "bun:test";
import { makeDeferQueue } from "../../src/gateway/panel/defer-queue";

describe("panel defer queue", () => {
  it("holds thunks per session and drains them in arrival order", () => {
    const q = makeDeferQueue();
    const order: string[] = [];
    q.hold("s1", () => { order.push("a"); });
    q.hold("s1", () => { order.push("b"); });
    q.hold("s2", () => { order.push("z"); });
    expect(q.pending("s1")).toBe(2);
    expect(q.pending("s2")).toBe(1);

    const drained = q.drain("s1");
    expect(drained.length).toBe(2);
    drained.forEach((f) => f());
    expect(order).toEqual(["a", "b"]);
    // s2 untouched
    expect(q.pending("s2")).toBe(1);
    // drained session is now empty
    expect(q.pending("s1")).toBe(0);
  });

  it("heldSessions lists sessions with pending thunks", () => {
    const q = makeDeferQueue();
    expect(q.heldSessions()).toEqual([]);
    q.hold("s1", () => {});
    q.hold("s3", () => {});
    expect(q.heldSessions().sort()).toEqual(["s1", "s3"]);
    q.drain("s1");
    expect(q.heldSessions()).toEqual(["s3"]);
  });

  it("drain of an unknown session is empty and safe", () => {
    const q = makeDeferQueue();
    expect(q.drain("nope")).toEqual([]);
  });
});
