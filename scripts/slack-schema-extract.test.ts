import { expect, test } from "bun:test";
import { extractMethods } from "./slack-schema-extract";

const spec = {
  paths: {
    "/plain.method": {
      post: {
        parameters: [
          { name: "token", in: "header", required: true },
          { name: "zeta", in: "formData" },
          { name: "alpha", in: "formData", required: true },
        ],
        responses: { "200": { schema: { properties: { ok: {}, thing: {} } } } },
      },
    },
    "/ref.method": {
      get: {
        parameters: [{ $ref: "#/parameters/chan" }, { in: "body", name: "body", schema: { $ref: "#/definitions/Body" } }],
        responses: { "200": { schema: { $ref: "#/definitions/Resp" } } },
      },
    },
    "/union.method": {
      post: {
        parameters: [],
        responses: { "200": { schema: { oneOf: [{ properties: { ok: {}, a: {} } }, { allOf: [{ properties: { b: {} } }, { $ref: "#/definitions/Resp" }] }] } } },
      },
    },
    "/undescribed.method": {
      post: {
        parameters: [],
        responses: { "200": { schema: { description: "This method either only returns a brief _OK_ response or a verbose schema is not available for this method.", properties: { ok: {} } } } },
      },
    },
  },
  parameters: { chan: { name: "channel", in: "formData", required: true } },
  definitions: {
    Body: { required: ["text"], properties: { text: {}, blocks: {} } },
    Resp: { properties: { ok: {}, loop: { type: "object" }, next: {} }, allOf: [{ $ref: "#/definitions/Resp" }] },
  },
};

test("plain parameters are sorted, the token is dropped, required ones are listed", () => {
  const { schemas } = extractMethods(spec, ["plain.method"]);
  expect(schemas["plain.method"]).toEqual({ params: ["alpha", "zeta"], required: ["alpha"], response: ["ok", "thing"] });
});

test("a $ref parameter and an in:body parameter are resolved", () => {
  const { schemas } = extractMethods(spec, ["ref.method"]);
  expect(schemas["ref.method"]!.params).toEqual(["blocks", "channel", "text"]);
  expect(schemas["ref.method"]!.required).toEqual(["channel", "text"]);
});

test("a $ref response is resolved, with a self-referencing definition not looping", () => {
  expect(extractMethods(spec, ["ref.method"]).schemas["ref.method"]!.response).toEqual(["loop", "next", "ok"]);
});

test("oneOf, allOf and $ref branches of a response are unioned", () => {
  expect(extractMethods(spec, ["union.method"]).schemas["union.method"]!.response).toEqual(["a", "b", "loop", "next", "ok"]);
});

test("a response the spec says it does not describe is marked unjudged", () => {
  const { schemas } = extractMethods(spec, ["undescribed.method", "plain.method"]);
  expect(schemas["undescribed.method"]).toMatchObject({ response: ["ok"], responseUnjudged: true });
  expect(schemas["plain.method"]).not.toHaveProperty("responseUnjudged");
});

test("a method absent from the spec is reported missing, not schema'd", () => {
  const r = extractMethods(spec, ["nope.method"]);
  expect(r.missing).toEqual(["nope.method"]);
  expect(r.schemas).toEqual({});
});
