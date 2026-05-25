import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { paths } from "../config/home";

export type KbEntry = {
  label: string;
  description: string;
  path: string;
  index_file: string;
  tags: string[];
};

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

let cached: KbEntry[] | null = null;

export function clearKbCache(): void {
  cached = null;
}

function resolveIndexFile(dir: string): string | null {
  const candidates = ["README.md", "index.md"];
  for (const name of candidates) {
    if (existsSync(join(dir, name))) return name;
  }
  const mdFiles = readdirSync(dir)
    .filter((e) => e.endsWith(".md") && statSync(join(dir, e)).isFile())
    .sort();
  return mdFiles[0] ?? null;
}

function extractMetadata(indexPath: string): { description: string; tags: string[] } {
  const raw = readFileSync(indexPath, "utf8");
  const fm = raw.match(FRONTMATTER_RE);
  let tags: string[] = [];
  if (fm?.[1]) {
    try {
      const parsed = (parseYaml(fm[1]) as Record<string, unknown>) ?? {};
      if (typeof parsed.description === "string" && parsed.description.trim()) {
        const desc = truncate(parsed.description.trim());
        if (Array.isArray(parsed.tags)) {
          tags = parsed.tags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);
        }
        return { description: desc, tags };
      }
    } catch {
      // fall through to first-prose-line
    }
  }
  const body = fm ? raw.slice(fm[0].length) : raw;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return { description: truncate(trimmed), tags };
    }
  }
  return { description: "", tags };
}

function truncate(text: string): string {
  return text.length <= 200 ? text : text.slice(0, 197) + "...";
}

export function loadKbs(): KbEntry[] {
  if (cached) return cached;
  const root = paths.knowledge;
  if (!existsSync(root)) {
    cached = [];
    return [];
  }
  const out: KbEntry[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const indexFile = resolveIndexFile(dir);
    if (!indexFile) continue;
    const { description, tags } = extractMetadata(join(dir, indexFile));
    out.push({ label: entry, description, path: dir, index_file: indexFile, tags });
  }
  cached = out;
  return out;
}
