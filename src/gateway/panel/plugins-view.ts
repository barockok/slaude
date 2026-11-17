/**
 * The console's read-only Plugins page: the latest report per node, grouped by
 * node label. Nothing here writes; the console has no plugin actions.
 */
import type { NodePluginsRow } from "../../db/node-plugins";
import { STATE_OFFERABLE, isSealedState, type ServerState } from "../../config/plugin-inventory";
import { computeSnapshot, loadInventory, type InventorySources } from "../core/plugin-inventory";
import type { PluginHttpView, PluginLabelView, PluginNodeView, PluginStdioView, PluginView, PluginsResponse } from "./api-types";

const STATE_CONFLICT = "conflict: nodes report different URLs";
const STATE_OFFERED = "offered";
const STATE_NO_LIVE_NODE = "not offered: no live node lists it";
const WARNING_UNSEALED = "a node with writable plugin files reports a different URL";

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
  const { rows, live } = await loadInventory(src);
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
      const disagreements = snapshot.unsealedDisagreements.get(label);
      const plugins = new Map<string, Acc>();
      const nodeView = (r: NodePluginsRow): PluginNodeView => ({ id: r.nodeId, instance: r.instance, live: live.has(r.instance), reportedAt: r.reportedAt });
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
          if (live.has(row.instance) && p.commit) acc.commits.add(p.commit);
          for (const s of p.stdio) {
            const missing = acc.stdio.get(s.name) ?? new Set<string>();
            if (!s.declared) missing.add(row.instance);
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
        nodes: nodeRows.map(nodeView).sort((a, b) => a.id.localeCompare(b.id) || a.instance.localeCompare(b.instance)),
        plugins: [...plugins.values()]
          .map(({ view, commits, stdio, http }) => {
            view.commits = [...commits].sort();
            view.drift = commits.size > 1;
            view.nodes.sort((a, b) => a.id.localeCompare(b.id) || a.instance.localeCompare(b.instance));
            view.stdio = [...stdio.entries()].map(([name, missing]): PluginStdioView => ({ name, notMountedOn: [...missing].sort() })).sort((a, b) => a.name.localeCompare(b.name));
            view.http = [...http.entries()]
              .map(([name, e]): PluginHttpView => {
                // Only this plugin's own sealed entry may show as offered or in conflict:
                // an unsealed plugin that shares a server name keeps its own state.
                const isOffered = !!offered?.has(name) && e.states.includes(STATE_OFFERABLE);
                const isConflict = !!conflicts?.has(name) && e.states.some((s) => isSealedState(s as ServerState));
                return {
                  name,
                  // The offered URL's host, so an unsealed report cannot put its host on the row.
                  host: hostOf(isOffered ? offered!.get(name)!.url : e.url),
                  state: httpState(e.states, isOffered, isConflict),
                  ...(isOffered && disagreements?.has(name) ? { warning: WARNING_UNSEALED } : {}),
                };
              })
              .sort((a, b) => a.name.localeCompare(b.name));
            return view;
          })
          .sort((a, b) => a.key.localeCompare(b.key)),
      };
    });
  return { available: true, labels };
}
