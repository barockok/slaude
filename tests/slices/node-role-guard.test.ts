/**
 * Slice F: a node never touches the database (node labels and routing spec
 * 4.0). The person-slice resolver, the slice seam, the tombstone repo and the
 * credential pointer module all read or write tables, so nothing under src/node or
 * src/agent may import them, and in the node role the seam answers legacy without
 * opening a database. (Nodes get memory scope and KB scope computed on the
 * gateway and passed as `allowedSources`.)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { sourceFiles } from "../helpers/string-authority-scan";

const FORBIDDEN = ["src/knowledge/person-slices.ts", "src/slices/decide.ts", "src/slices/sites.ts", "src/db/slice-tombstones.ts", "src/db/credential-pointers.ts"];

function importsOf(file: string): string[] {
  // Type-only imports are erased at compile time and load nothing.
  const text = readFileSync(file, "utf8").replace(/\b(?:import|export)\s+type\b[^;]*?from\s+["'][^"']+["']/g, "");
  const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]!);
  const out: string[] = [];
  for (const s of specs) {
    const base = normalize(join(dirname(file), s));
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) {
      if (existsSync(c) && /\.(ts|tsx)$/.test(c)) {
        out.push(c);
        break;
      }
    }
  }
  return out;
}

/** The first chain from a root to a forbidden module, or null. */
function chainTo(root: string, seen = new Set<string>()): string[] | null {
  const queue: string[][] = [[root]];
  while (queue.length) {
    const path = queue.shift()!;
    const cur = path[path.length - 1]!;
    if (FORBIDDEN.includes(cur)) return path;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of importsOf(cur)) queue.push([...path, next]);
  }
  return null;
}

describe("node role never reaches the database seams of slice F", () => {
  // A static chain from a node file is not a usable check: the node boot already imports modules
  // (the access seam, the domain layer) that import database code they never call in that role. So the
  // guard is the direct import, plus the runtime proof below.
  test("no file under src/node or src/agent imports a forbidden module directly", () => {
    const bad = [...sourceFiles("src/node"), ...sourceFiles("src/agent")].filter((f) => importsOf(f).some((i) => FORBIDDEN.includes(i)));
    expect(bad).toEqual([]);
  });

  test("the roots exist and the walker follows imports", () => {
    expect(sourceFiles("src/node").length).toBeGreaterThan(3);
    expect(sourceFiles("src/agent").length).toBeGreaterThan(3);
    // gateway.ts (not a node file) does reach the seam: proves the walker follows imports.
    expect(chainTo("src/gateway/core/gateway.ts")).not.toBeNull();
  });

  test("in the node role the shadow seam and the resolver touch no database and never throw", async () => {
    const home = mkdtempSync(join(tmpdir(), "slaude-node-slices-"));
    try {
      const script = `
        process.env.SLAUDE_PERSON_SLICES = "shadow";
        const D = await import(${JSON.stringify(join(import.meta.dir, "../../src/slices/decide.ts"))});
        const P = await import(${JSON.stringify(join(import.meta.dir, "../../src/knowledge/person-slices.ts"))});
        await D.decidePersonSlices({ site: "brain.gate_speaker", teamId: "T0EXAMPLE", slackUserId: "U0EXAMPLE" });
        await D.settlePersonSliceShadows();
        const r = await P.personSlicesDetailed("T0EXAMPLE", "U0EXAMPLE");
        console.log("RESULT:" + r.status + ":" + r.slices.reads.join(","));
      `;
      for (const dbEnv of [{ SLAUDE_DB: "pg" }, {}]) {
        const proc = Bun.spawn(["bun", "-e", script], {
          env: { PATH: process.env.PATH ?? "", HOME: home, SLAUDE_HOME: home, SLAUDE_ROLE: "node", ...dbEnv },
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        const out = await new Response(proc.stdout).text();
        expect(out).toContain("RESULT:error:user-u0example");
      }
      expect(readdirSync(home).filter((f) => /db|sqlite|pglite|slaude/i.test(f))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
