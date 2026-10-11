/**
 * Derive e2e/fake-slack/schemas/methods.json from the archived Slack Web API OpenAPI 2.0 spec
 * (slackapi/slack-api-specs, MIT). Keeps only what the fake's schema guard judges: per method the
 * parameter names, the required ones and the top-level response property names
 * (see slack-schema-extract.ts).
 *
 *   bun scripts/vendor-slack-schemas.ts <spec path | URL> --commit <sha> [--license MIT] [--spec-file <path in repo>] [--out <file>]
 *
 * Methods the spec does not describe are left out (the guard does not judge them). Dependency-free.
 */
import { writeFileSync } from "node:fs";
import { extractMethods } from "./slack-schema-extract";

async function load(src: string): Promise<Record<string, any>> {
  if (/^https?:\/\//.test(src)) return (await (await fetch(src)).json()) as Record<string, any>;
  return (await Bun.file(src).json()) as Record<string, any>;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const src = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const commit = flag("commit");
if (!src || !commit) {
  console.error("usage: bun scripts/vendor-slack-schemas.ts <spec path | URL> --commit <sha> [--license MIT] [--spec-file <path in repo>] [--out <file>]");
  process.exit(2);
}
const { KNOWN_METHODS } = await import("../e2e/fake-slack/core/web-api");
const { schemas, missing } = extractMethods(await load(src), KNOWN_METHODS);
const out = flag("out", "e2e/fake-slack/schemas/methods.json")!;
const doc = {
  source: "slackapi/slack-api-specs",
  url: "https://github.com/slackapi/slack-api-specs",
  spec_file: flag("spec-file", "web-api/slack_web_openapi_v2_without_examples.json"),
  copyright: "Copyright (c) 2017 SlackAPI",
  commit,
  license: flag("license", "MIT"),
  methods: schemas,
};
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${out}: ${Object.keys(schemas).length} methods`);
if (missing.length) console.log(`not in the spec (left un-schema'd): ${missing.join(", ")}`);
