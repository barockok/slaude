/** Per Web API method: the parameter names, the required ones and the top-level response property names. */
export type MethodSchemas = Record<string, { params: string[]; required: string[]; response: string[]; responseUnjudged?: boolean }>;

export interface SchemaGuard {
  /** Violation messages for a request's params; an empty array is clean. */
  checkRequest(method: string, params: Record<string, unknown>): string[];
  /** Violation messages for a response body; an empty array is clean. */
  checkResponse(method: string, body: Record<string, unknown>): string[];
}

/**
 * Judge fake Slack traffic against schemas derived from Slack's published OpenAPI spec.
 *
 * Limits, so a green result is read correctly:
 * - The checks are only as strong as the archived spec. `required` lists and top-level response
 *   properties are whatever the spec says; where it marks nothing required (chat.delete, say),
 *   a dropped argument is not caught.
 * - Only top-level response properties are judged; nested ones are not.
 * - `token` is always an allowed parameter and `ok`/`error` always allowed response properties.
 * - A parameter present with a `null` value counts as supplied (only `undefined` is absent).
 * - Methods with no schema are not judged at all (assistant.threads.setStatus is not in the
 *   archived spec, yet the gateway calls it). A schema with `responseUnjudged` skips only the
 *   response check (the spec does not describe that response, e.g. search.messages).
 */
export function createSchemaGuard(schemas: MethodSchemas): SchemaGuard {
  const schemaOf = (method: string) => (Object.hasOwn(schemas, method) ? schemas[method] : undefined);
  return {
    checkRequest(method, params) {
      const s = schemaOf(method);
      if (!s) return [];
      const out: string[] = [];
      for (const k of Object.keys(params)) {
        if (k !== "token" && !s.params.includes(k)) out.push(`${method}: unknown parameter "${k}"`);
      }
      for (const k of s.required) {
        if (k !== "token" && params[k] === undefined) out.push(`${method}: missing required parameter "${k}"`);
      }
      return out;
    },
    checkResponse(method, body) {
      const s = schemaOf(method);
      if (!s || s.responseUnjudged) return [];
      return Object.keys(body)
        .filter((k) => k !== "ok" && k !== "error" && !s.response.includes(k))
        .map((k) => `${method}: unknown response property "${k}"`);
    },
  };
}
