import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every test run under a fresh $SLAUDE_HOME so db/schema bootstrap and
// soul/loader writes don't touch the operator's real ~/.slaude.
const home = mkdtempSync(join(tmpdir(), "slaude-test-"));
process.env.SLAUDE_HOME = home;

// Seed a .env file in the test home so loadDotenv has something to parse on
// first import of config/env. Covers the quoted-value / dedup branches.
writeFileSync(
  join(home, ".env"),
  [
    'SLAUDE_TEST_QUOTED="hello"',
    "SLAUDE_TEST_SINGLE='world'",
    "SLAUDE_TEST_PLAIN=plain",
    "# comment line — ignored",
    "ALSO IGNORED",
    "",
  ].join("\n"),
);

process.env.SLAUDE_APPROVERS = "";
process.env.SLAUDE_HEALTH_PORT = "0";
process.env.SLAUDE_DEFAULT_MODE = "default";
// Prevent leaked CLAUDE_CODE_OAUTH_TOKEN from operator shell affecting tests.
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
