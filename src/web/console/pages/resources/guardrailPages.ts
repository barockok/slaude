/**
 * The console's own pages under /guardrails: /guardrails/new and
 * /guardrails/test. The same names are RESERVED_SLUGS in
 * src/guardrails/format.ts (a test checks they agree). A guardrail stored
 * under one of these names from before they were reserved is reached at
 * /guardrails/~/<name>, which no name can shadow (`~` is never in a name).
 */
export const CONSOLE_GUARDRAIL_PAGES: ReadonlySet<string> = new Set(["new", "test"]);
