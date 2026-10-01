/** Per Web API method: the parameter names, the required ones and the top-level response property names. */
export type MethodSchemas = Record<string, { params: string[]; required: string[]; response: string[] }>;

export interface SchemaGuard {
  /** Violation messages for a request's params; an empty array is clean. */
  checkRequest(method: string, params: Record<string, unknown>): string[];
  /** Violation messages for a response body; an empty array is clean. */
  checkResponse(method: string, body: Record<string, unknown>): string[];
}

/**
 * Judge fake Slack traffic against schemas derived from Slack's published OpenAPI spec.
 * `token` is always an allowed parameter and `ok`/`error` always allowed response properties.
 * Methods with no schema are not judged.
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
      if (!s) return [];
      return Object.keys(body)
        .filter((k) => k !== "ok" && k !== "error" && !s.response.includes(k))
        .map((k) => `${method}: unknown response property "${k}"`);
    },
  };
}
