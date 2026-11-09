/**
 * The console's read-only Plugins page: the latest report per node, grouped by
 * node label. Nothing here writes; the console has no plugin actions.
 */
import type { NodePluginsRow } from "../../db/node-plugins";
import { STATE_OFFERABLE } from "../../config/plugin-inventory";
import { computeSnapshot, type InventorySources } from "../core/plugin-inventory";
import type { PluginHttpView, PluginLabelView, PluginNodeView, PluginStdioView, PluginView, PluginsResponse } from "./api-types";

const STATE_CONFLICT = "conflict: nodes report different URLs";
const STATE_OFFERED = "offered";
const STATE_NO_LIVE_NODE = "not offered: no live node lists it";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

interface Acc {
  view: PluginView;
  commits: Set<string>;
  stdio: Map<string, Set<string>>;
  http: Map<string, { url: string; states: string[] }>;
}

/** A server's page state: conflict first, then offered by a live node, then the
 *  first reported reason; offerable but with no live node is not offered. */
function httpState(states: string[], offered: boolean, conflict: boolean): string {
  if (conflict) return STATE_CONFLICT;
  if (offered) return STATE_OFFERED;
  return states.find((s) => s !== STATE_OFFERABLE) ?? STATE_NO_LIVE_NODE;
}

export async function pluginsView(src: InventorySources): Promise<PluginsResponse> {
  const rows = await src.rows();
  const live = await src.live(rows.map((r) => r.nodeId));
  const snapshot = computeSnapshot(rows, live);
  const byLabel = new Map<string, NodePluginsRow[]>();
  for (const row of rows) {
    for (const label of row.labels) {
      const list = byLabel.get(label) ?? [];
      list.push(row);
      byLabel.set(label, list);
    }
  }
  const labels: PluginLabelView[] = [...byLabel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, nodeRows]) => {
      const offered = snapshot.servers.get(label);
      const conflicts = snapshot.conflicts.get(label);
      const plugins = new Map<string, Acc>();
      const nodeView = (r: NodePluginsRow): PluginNodeView => ({ id: r.nodeId, live: live.has(r.nodeId), reportedAt: r.reportedAt });
      for (const row of nodeRows) {
        for (const p of row.report.plugins) {
          const key = `${p.name}@${p.marketplace}`;
          let acc = plugins.get(key);
          if (!acc) {
            acc = {
              view: { key, name: p.name, marketplace: p.marketplace, commits: [], drift: false, skills: p.skills, commands: p.commands, agents: p.agents, hooks: p.hooks, nodes: [], stdio: [], http: [] },
              commits: new Set(),
              stdio: new Map(),
              http: new Map(),
            };
            plugins.set(key, acc);
          }
          acc.view.nodes.push({ ...nodeView(row), commit: p.commit });
          if (live.has(row.nodeId) && p.commit) acc.commits.add(p.commit);
          for (const s of p.stdio) {
            const missing = acc.stdio.get(s.name) ?? new Set<string>();
            if (!s.declared) missing.add(row.nodeId);
            acc.stdio.set(s.name, missing);
          }
          for (const s of p.http) {
            const e = acc.http.get(s.name) ?? { url: s.url, states: [] };
            e.states.push(s.state);
            acc.http.set(s.name, e);
          }
        }
      }
      return {
        label,
        nodes: nodeRows.map(nodeView).sort((a, b) => a.id.localeCompare(b.id)),
        plugins: [...plugins.values()]
          .map(({ view, commits, stdio, http }) => {
            view.commits = [...commits].sort();
            view.drift = commits.size > 1;
            view.nodes.sort((a, b) => a.id.localeCompare(b.id));
            view.stdio = [...stdio.entries()].map(([name, missing]): PluginStdioView => ({ name, notMountedOn: [...missing].sort() })).sort((a, b) => a.name.localeCompare(b.name));
            view.http = [...http.entries()]
              .map(([name, e]): PluginHttpView => ({ name, host: hostOf(e.url), state: httpState(e.states, !!offered?.has(name), !!conflicts?.has(name)) }))
              .sort((a, b) => a.name.localeCompare(b.name));
            return view;
          })
          .sort((a, b) => a.key.localeCompare(b.key)),
      };
    });
  return { available: true, labels };
}
