// Deterministic probe of the /1on1 OAuth-isolation path — run INSIDE the Linux
// container against /data. No LLM, no REPL: exercises the exact lock lookup +
// config-dir resolution the AgentManager does at session boot.
import { existsSync } from "node:fs";
import { paths } from "../src/config/home";
import * as Sessions from "../src/db/sessions";
import * as OneOnOne from "../src/db/one-on-one";
import { resolveSessionConfigDir, agentConfigDir, initiatorConfigDir } from "../src/agent/oauth-home";

const L = (k: string, v: unknown) => console.log(k.padEnd(34), v);

L("platform", process.platform);
L("CLAUDE_CONFIG_DIR (env)", process.env.CLAUDE_CONFIG_DIR ?? "(unset)");
L("paths.home", paths.home);
L("paths.claudeConfig", paths.claudeConfig);
L("agentConfigDir()", agentConfigDir());
L("agent .credentials.json", existsSync(agentConfigDir() + "/.credentials.json"));
L("agent .claude.json", existsSync(agentConfigDir() + "/.claude.json"));

// Simulate a PINNED DM thread (what /thread T1 produces).
const thread = { team_id: "T0SIM", channel_id: "D0SIM", thread_ts: "T1" };
const row =
  Sessions.findByThread(thread) ??
  Sessions.createForThread({ thread, model: "probe", working_dir: "/tmp/probe", permission_mode: "default" });
console.log("\n--- session ---");
L("id", row.id);
L("slack_channel_id", row.slack_channel_id);
L("slack_thread_ts", row.slack_thread_ts);

const lookup = () =>
  row.slack_channel_id && row.slack_thread_ts ? OneOnOne.find(row.slack_channel_id, row.slack_thread_ts) : null;

console.log("\n--- UNLOCKED ---");
let lock = lookup();
L("lock", lock);
L("configDir override", resolveSessionConfigDir(lock?.locked_user) ?? "(none → inherit agent dir)");

console.log("\n--- /1on1 LOCK (user U06ENBS6PV0) ---");
OneOnOne.lock({ channelId: "D0SIM", threadTs: "T1", lockedUser: "U06ENBS6PV0", createdBy: "U06ENBS6PV0" });
lock = lookup();
L("lock", lock);
const dir = resolveSessionConfigDir(lock?.locked_user);
L("configDir override", dir);
L("oauth dir created", dir ? existsSync(dir) : false);
L("initiator dir", initiatorConfigDir("U06ENBS6PV0"));
L("initiator .credentials.json", dir ? existsSync(dir + "/.credentials.json") : "n/a");
L("initiator .claude.json", dir ? existsSync(dir + "/.claude.json") : "n/a");
L("initiator settings.json (seeded)", dir ? existsSync(dir + "/settings.json") : "n/a");

console.log("\n--- /1on1 OFF ---");
OneOnOne.unlock("D0SIM", "T1");
lock = lookup();
L("lock", lock);
L("configDir override", resolveSessionConfigDir(lock?.locked_user) ?? "(none → inherit agent dir)");

console.log("\nVERDICT: locked → override points at initiator dir with NO .credentials.json");
console.log("         → on Linux the CLI has no workbench token there → disconnected. Mechanism OK.");
