export interface CallRecord {
  seq: number;
  at: number;
  kind: "api" | "inbound" | "response_url";
  method: string;
  app?: string;
  ok: boolean;
  error?: string;
  status: number;
  args?: Record<string, unknown>;
  /** Set when the method is not one the fake implements. */
  unknown?: boolean;
  /** Set by the schema guard when the request or response diverges from the vendored Slack schema. */
  schemaViolations?: string[];
  detail?: Record<string, unknown>;
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...rest } = args;
  return rest;
}

/** Ordered record of everything that crossed the fake's wire. Tests assert on it. */
export class CallLog {
  #rows: CallRecord[] = [];
  #seq = 0;

  add(r: Omit<CallRecord, "seq" | "at">, at: number = Date.now()): CallRecord {
    const row: CallRecord = { ...r, seq: ++this.#seq, at };
    this.#rows.push(row);
    return row;
  }

  all(): CallRecord[] {
    return [...this.#rows];
  }

  where(pred: (r: CallRecord) => boolean): CallRecord[] {
    return this.#rows.filter(pred);
  }

  count(method: string): number {
    return this.#rows.filter((r) => r.method === method).length;
  }

  clear(): void {
    this.#rows = [];
  }
}
