import { describe, it, expect } from "bun:test";
import { TypedEmitter, seedText } from "../../src/voice/provider/types";

type E = { ping: (n: number) => void };
class X extends TypedEmitter<E> { go(n: number) { this.fire("ping", n); } }

describe("TypedEmitter", () => {
  it("delivers to every listener in order", () => {
    const x = new X();
    const got: number[] = [];
    x.on("ping", (n) => got.push(n));
    x.on("ping", (n) => got.push(n * 10));
    x.go(2);
    expect(got).toEqual([2, 20]);
  });
  it("a throwing listener does not stop the others", () => {
    const x = new X();
    const got: number[] = [];
    x.on("ping", () => { throw new Error("boom"); });
    x.on("ping", (n) => got.push(n));
    x.go(1);
    expect(got).toEqual([1]);
  });
});

describe("seedText", () => {
  it("returns conversation context prefix plus seed", () => {
    const result = seedText("prior exchange here");
    expect(result).toBe("Conversation so far (restored after reconnect):\nprior exchange here");
  });
});
