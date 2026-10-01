import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../src/config/home";
import { loadPersonaRegistry } from "../../src/persona/registry";

let root: string;
let prevPersonas: string;
let prevUrl: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slaude-personas-"));
  const dir = join(root, "ada");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SOUL.md"), "# Ada\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ slackUserId: "U0ADA", userToken: "user-token-seam" }));
  prevPersonas = paths.personas;
  (paths as { personas: string }).personas = root;
  prevUrl = process.env.SLAUDE_SLACK_API_URL;
});

afterEach(() => {
  (paths as { personas: string }).personas = prevPersonas;
  if (prevUrl === undefined) delete process.env.SLAUDE_SLACK_API_URL;
  else process.env.SLAUDE_SLACK_API_URL = prevUrl;
  rmSync(root, { recursive: true, force: true });
});

test("the persona's user-token client follows SLAUDE_SLACK_API_URL", () => {
  process.env.SLAUDE_SLACK_API_URL = "http://fake-slack:8080/api";
  const p = loadPersonaRegistry().lookupByName("ada")!;
  expect((p.outClient as any).slackApiUrl).toBe("http://fake-slack:8080/api/");
});

test("with it unset the persona client keeps the SDK default", () => {
  delete process.env.SLAUDE_SLACK_API_URL;
  const p = loadPersonaRegistry().lookupByName("ada")!;
  expect((p.outClient as any).slackApiUrl).toBe("https://slack.com/api/");
});
