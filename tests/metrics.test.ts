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

  test("histogram observe + render (cumulative buckets, +Inf, sum, count)", () => {
    const r = new Registry({ agent: "test" });
    const h = r.histogram("lat_seconds", "Test histogram.", [0.1, 0.5, 1]);
    h.observe(0.05);
    h.observe(0.3);
    h.observe(0.7);
    h.observe(4); // over the largest bucket → only +Inf
    const out = r.render();
    expect(out).toContain("# TYPE lat_seconds histogram");
    expect(out).toContain(`lat_seconds_bucket{agent="test",le="0.1"} 1`);
    expect(out).toContain(`lat_seconds_bucket{agent="test",le="0.5"} 2`);
    expect(out).toContain(`lat_seconds_bucket{agent="test",le="1"} 3`);
    expect(out).toContain(`lat_seconds_bucket{agent="test",le="+Inf"} 4`);
    expect(out).toContain(`lat_seconds_sum{agent="test"} ${0.05 + 0.3 + 0.7 + 4}`);
    expect(out).toContain(`lat_seconds_count{agent="test"} 4`);
  });

  test("histogram keeps per-label-set series apart", () => {
    const r = new Registry();
    const h = r.histogram("d", "h", [1]);
    h.observe(0.5, { q: "a" });
    h.observe(2, { q: "b" });
    const out = r.render();
    expect(out).toContain(`d_bucket{le="1",q="a"} 1`);
    expect(out).toContain(`d_bucket{le="+Inf",q="a"} 1`);
    expect(out).toContain(`d_bucket{le="1",q="b"} 0`);
    expect(out).toContain(`d_bucket{le="+Inf",q="b"} 1`);
    expect(out).toContain(`d_count{q="b"} 1`);
  });
});
