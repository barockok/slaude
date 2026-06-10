import type { MemoryProvider } from "./provider";
import { memory as sqliteMemory } from "./sqlite-provider";
import { BrainMemoryProvider } from "./brain-provider";
import { brainEnabled } from "../knowledge/brain";

/**
 * Active memory provider. Brain-backed by default when the brain is enabled;
 * SLAUDE_MEMORY=sqlite reverts to the flat sqlite turns store.
 */
export const memory: MemoryProvider =
  process.env.SLAUDE_MEMORY === "sqlite" || !brainEnabled()
    ? sqliteMemory
    : new BrainMemoryProvider();
