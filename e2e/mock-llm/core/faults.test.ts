import { describe, expect, test } from "bun:test";
import { errorBody, planFaults } from "./faults";
import type { FaultPlan } from "./faults";
import type { Tag } from "./types";

const tag = (params: Record<string, string>): Tag => ({ name: "echo" as const, params });

describe("planFaults", () => {
  test("no tag, or a tag with no fault params, proxies untouched", () => {
    const none: FaultPlan = { action: "proxy", delayMs: 0, intervalMs: 0, status: 0, dropAfterEvents: 0 };
    expect(planFaults(null, 0)).toEqual(none);
    expect(planFaults(tag({}), 0)).toEqual(none);
  });

  test("ttft and interval set timing without changing the action", () => {
    expect(planFaults(tag({ ttft: "2s", interval: "50ms" }), 0)).toMatchObject({ action: "proxy", delayMs: 2000, intervalMs: 50 });
  });

  test("fail returns the status on the first attempt and succeeds on the retry", () => {
    expect(planFaults(tag({ fail: "529" }), 0)).toMatchObject({ action: "error", status: 529 });
    expect(planFaults(tag({ fail: "529" }), 1).action).toBe("proxy");
  });

  test("until-retry keeps failing until that many retries have happened", () => {
    const t = tag({ fail: "429", "until-retry": "2" });
    expect(planFaults(t, 0).action).toBe("error");
    expect(planFaults(t, 1).action).toBe("error");
    expect(planFaults(t, 2).action).toBe("proxy");
  });

  test("drop cuts the stream after k events", () => {
    expect(planFaults(tag({ drop: "3" }), 0)).toMatchObject({ action: "drop", dropAfterEvents: 3 });
  });

  test("malformed and hang", () => {
    expect(planFaults(tag({ malformed: "1" }), 0).action).toBe("malformed");
    expect(planFaults(tag({ hang: "1" }), 0).action).toBe("hang");
  });

  test("overflow is a 400 prompt-too-long error", () => {
    expect(planFaults(tag({ overflow: "1" }), 0)).toMatchObject({ action: "error", status: 400 });
  });

  test("precedence: hang > overflow > fail > drop > malformed", () => {
    const all = { hang: "1", overflow: "1", fail: "529", drop: "2", malformed: "1" };
    expect(planFaults(tag(all), 0).action).toBe("hang");
    const { hang: _h, ...noHang } = all;
    expect(planFaults(tag(noHang), 0)).toMatchObject({ action: "error", status: 400 });
    const { overflow: _o, ...noOverflow } = noHang;
    expect(planFaults(tag(noOverflow), 0)).toMatchObject({ action: "error", status: 529 });
    const { fail: _f, ...noFail } = noOverflow;
    expect(planFaults(tag(noFail), 0).action).toBe("drop");
  });
});

describe("errorBody", () => {
  test("maps statuses to Anthropic error types", () => {
    expect(errorBody(429).error.type).toBe("rate_limit_error");
    expect(errorBody(529).error.type).toBe("overloaded_error");
    expect(errorBody(400).error.type).toBe("invalid_request_error");
    expect(errorBody(401).error.type).toBe("authentication_error");
    expect(errorBody(500).error.type).toBe("api_error");
  });
  test("the 400 body reads like a real prompt-too-long error", () => {
    expect(errorBody(400).error.message).toContain("prompt is too long");
    expect(errorBody(400).type).toBe("error");
  });
});
