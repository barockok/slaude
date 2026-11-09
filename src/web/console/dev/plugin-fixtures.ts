/** Plugins fixtures for the dev stub and the Playwright smoke test. Generic names only. */
import type { PluginsResponse } from "../../../gateway/panel/api-types";

export function pluginFixtures(now: number, empty: boolean, mono: boolean): PluginsResponse {
  if (mono) return { available: false, labels: [] };
  if (empty) return { available: true, labels: [] };
  return {
    available: true,
    labels: [
      {
        label: "default",
        nodes: [
          { id: "node-a", live: true, reportedAt: now - 3_600_000 },
          { id: "node-b", live: false, reportedAt: now - 7_200_000 },
        ],
        plugins: [
          {
            key: "example-toolkit@example-market",
            name: "example-toolkit",
            marketplace: "example-market",
            commits: ["a1b2c3d4", "e5f6a7b8"],
            drift: true,
            skills: 3,
            commands: 2,
            agents: 1,
            hooks: 0,
            nodes: [
              { id: "node-a", live: true, reportedAt: now - 3_600_000, commit: "a1b2c3d4" },
              { id: "node-b", live: false, reportedAt: now - 7_200_000, commit: "e5f6a7b8" },
            ],
            stdio: [{ name: "local-index", notMountedOn: ["node-a"] }],
            http: [
              { name: "docs-wiki", host: "wiki.example.com", state: "offered" },
              { name: "needs-key", host: "api.example.com", state: "not offered: needs static headers" },
              { name: "split-url", host: "one.example.com", state: "conflict: nodes report different URLs" },
            ],
          },
        ],
      },
      {
        label: "gpu",
        nodes: [{ id: "node-gpu", live: true, reportedAt: now - 600_000 }],
        plugins: [
          {
            key: "example-render@example-market",
            name: "example-render",
            marketplace: "example-market",
            commits: ["9f8e7d6c"],
            drift: false,
            skills: 1,
            commands: 0,
            agents: 0,
            hooks: 1,
            nodes: [{ id: "node-gpu", live: true, reportedAt: now - 600_000, commit: "9f8e7d6c" }],
            stdio: [],
            http: [{ name: "render-api", host: "render.example.com", state: "not offered: plugin files are writable by the agent" }],
          },
        ],
      },
    ],
  };
}
