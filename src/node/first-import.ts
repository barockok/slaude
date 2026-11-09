/**
 * The node entry's FIRST import, so it runs before any other module is evaluated.
 *
 *  - Marks this process as a node entry, so config/env.ts skips $SLAUDE_HOME/.env
 *    (agent-writable) whatever SLAUDE_ROLE says.
 *  - Makes the process non-dumpable (./harden.ts).
 *
 * Imports nothing that reads configuration. Nodes must be started by executing
 * src/node/main.ts directly: `bun run worker` leaves a parent bun process (PID 1
 * in a container) holding the node's credential in an environment a same-uid tool
 * can read. tests/deploy/node-entry.test.ts bans it in the shipped manifests.
 */
import { hardenNodeProcess } from "./harden";

(globalThis as Record<symbol, unknown>)[Symbol.for("slaude.nodeEntry")] = true;
hardenNodeProcess();
