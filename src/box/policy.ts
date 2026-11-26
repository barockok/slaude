/**
 * A box's policy: everything in a box that is not its image (box spec,
 * "Terminology"). Types only, plus the defaults; the schema that produces a
 * policy from a box.yaml is src/box/definition.ts.
 *
 * A policy holds no secret. There is no field for one.
 */

/** The isolation technology a node offers, weakest first. */
export type BoxTier = "none" | "bwrap" | "gvisor";

export const BOX_TIERS: readonly BoxTier[] = ["none", "bwrap", "gvisor"];

/** `none < bwrap < gvisor`: true when `offered` is at least as strong as `required`. */
export function tierSatisfies(offered: BoxTier, required: BoxTier): boolean {
  return BOX_TIERS.indexOf(offered) >= BOX_TIERS.indexOf(required);
}

export interface BoxResources {
  /** Cores, a ceiling. */
  cpu: number;
  /** A ceiling; the sandbox is killed above it. */
  memoryMb: number;
  /** What a node sets aside to admit this box. */
  memoryReserveMb: number;
  pids: number;
  /** The durable home. */
  homeMb: number;
  /** node_modules, .venv and the like. */
  workspaceExtrasMb: number;
  /** Throwaway system-level writes. */
  rootOverlayMb: number;
}

export interface BoxEgress {
  /** Host names with an optional port and an optional leading `*.`. Everything else is refused. */
  allow: string[];
  /** Wins over allow. */
  deny: string[];
}

/** A program in the image. It gets no credential. */
export interface BoxStdioServer {
  command: string;
  args: string[];
}

export interface BoxPolicy {
  /** The weakest tier this box may run on. */
  tier: BoxTier;
  resources: BoxResources;
  egress: BoxEgress;
  /** Not secret. */
  env: Record<string, string>;
  mcp: { stdio: Record<string, BoxStdioServer> };
  durable: { exclude: string[] };
  refresh: { force: boolean; note: string };
}

export const DEFAULT_BOX_RESOURCES: Readonly<Omit<BoxResources, "memoryReserveMb">> = {
  cpu: 2,
  memoryMb: 3072,
  pids: 512,
  homeMb: 4096,
  workspaceExtrasMb: 4096,
  rootOverlayMb: 2048,
};

/** Owner decision 8: a box reserves about a third of its memory ceiling by default. */
export function defaultMemoryReserveMb(memoryMb: number): number {
  return Math.max(1, Math.floor(memoryMb / 3));
}

/** A policy with every default and nothing allowed out. A fresh object each call. */
export function defaultBoxPolicy(): BoxPolicy {
  return {
    tier: "gvisor",
    resources: { ...DEFAULT_BOX_RESOURCES, memoryReserveMb: defaultMemoryReserveMb(DEFAULT_BOX_RESOURCES.memoryMb) },
    egress: { allow: [], deny: [] },
    env: {},
    mcp: { stdio: {} },
    durable: { exclude: [] },
    refresh: { force: false, note: "" },
  };
}
