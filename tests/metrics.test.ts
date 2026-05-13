import { describe, test, expect } from "bun:test";
import { Registry, parseLabels } from "../src/metrics";

describe("parseLabels", () => {
  test("undefined/empty → {}", () => {
    expect(parseLabels(undefined)).toEqual({});
    expect(parseLabels("")).toEqual({});
  });
  test("basic comma-sep", () => {
    expect(parseLabels("a=1,b=2")).toEqual({ a: "1", b: "2" });
  });
  test("trims whitespace", () => {
    expect(parseLabels(" a = 1 , b = 2 ")).toEqual({ a: "1", b: "2" });
  });
  test("drops malformed entries (no =, empty key, invalid key)", () => {
    expect(parseLabels("a,=v,1bad=v,good=v")).toEqual({ good: "v" });
  });
  test("value can contain =", () => {
    expect(parseLabels("a=x=y")).toEqual({ a: "x=y" });
  });
});

describe("Registry", () => {
  test("counter inc + render", () => {
    const r = new Registry({ agent: "test" });
    const c = r.counter("foo_total", "Test counter.");
    c.inc({ x: "a" });
    c.inc({ x: "a" });
    c.inc({ x: "b" }, 3);
    const out = r.render();
    expect(out).toContain("# HELP foo_total Test counter.");
    expect(out).toContain("# TYPE foo_total counter");
    expect(out).toContain(`foo_total{agent="test",x="a"} 2`);
    expect(out).toContain(`foo_total{agent="test",x="b"} 3`);
  });

  test("gauge set + render", () => {
    const r = new Registry();
    const g = r.gauge("bar", "Test gauge.");
    g.set(0.42);
    g.set(0.99, { sess: "s1" });
    const out = r.render();
    expect(out).toContain("# TYPE bar gauge");
    expect(out).toContain("bar 0.42");
    expect(out).toContain(`bar{sess="s1"} 0.99`);
  });

  test("static labels merged + escaped", () => {
    const r = new Registry({ env: 'prod"x' });
    r.counter("c", "h").inc({ k: 'v"' });
    const out = r.render();
    expect(out).toContain(`c{env="prod\\"x",k="v\\""} 1`);
  });

  test("no labels renders bare name", () => {
    const r = new Registry();
    r.counter("c", "h").inc();
    expect(r.render()).toContain("c 1\n");
  });

  test("setStaticLabels replaces", () => {
    const r = new Registry({ a: "1" });
    r.counter("c", "h").inc();
    r.setStaticLabels({ b: "2" });
    expect(r.render()).toContain(`c{b="2"} 1`);
  });

  test("repeated counter() returns handles sharing series", () => {
    const r = new Registry();
    r.counter("c", "h").inc({ x: "1" });
    r.counter("c", "h").inc({ x: "1" });
    expect(r.render()).toContain("c{x=\"1\"} 2");
  });
});
