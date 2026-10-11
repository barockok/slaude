import type { MemoryProvider } from "./provider";
import { memory as sqliteMemory } from "./sqlite-provider";
import { BrainMemoryProvider } from "./brain-provider";
import { brainEnabled } from "../knowledge/brain";

/**
 * Active memory provider. Brain-backed by default when the brain is enabled;
 * SLAUDE_MEMORY=sqlite reverts to the flat sqlite turns store.
 */
export let memory: MemoryProvider =
  process.env.SLAUDE_MEMORY === "sqlite" || !brainEnabled()
    ? sqliteMemory
    : new BrainMemoryProvider();

/** Test seam: replace the process provider (the live binding updates every
 *  importer that reads it at call time, such as the gateway's memory plane). */
export function __setMemoryForTests(p: MemoryProvider): void {
  memory = p;
}
