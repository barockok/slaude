/**
 * The operator console, served at /panel: shell, navigation and the page for
 * each route.
 */
import { matchPath } from "../lib/router";
import { AppFrame, type Identity, type NavEntry } from "../shared/AppFrame";
import { NotFoundPage, PlaceholderPage } from "../shared/PlaceholderPage";
import { api } from "./client";
import { AccessPage } from "./pages/AccessPage";
import { AgentDetailPage, isAgentTab } from "./pages/agent/AgentDetailPage";
import { AgentsPage } from "./pages/AgentsPage";
import { BoundariesPage } from "./pages/domain/BoundariesPage";
import { UsersPage } from "./pages/domain/UsersPage";
import { MergesPage } from "./pages/domain/MergesPage";
import { ProposalsPage } from "./pages/domain/ProposalsPage";
import { AuditPage } from "./pages/AuditPage";
import { EnvironmentsPage } from "./pages/EnvironmentsPage";
import { MemoryPageView } from "./pages/memory/MemoryPageView";
import { MemoryStorePage } from "./pages/memory/MemoryStorePage";
import { MemoryStoresPage } from "./pages/memory/MemoryStoresPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SessionDetailPage, isSessionTab } from "./pages/session/SessionDetailPage";
import { SessionsPage } from "./pages/SessionsPage";
import { GuardrailDetailPage } from "./pages/resources/GuardrailDetailPage";
import { GuardrailEditPage } from "./pages/resources/GuardrailEditPage";
import { GuardrailTestPage } from "./pages/resources/GuardrailTestPage";
import { GuardrailsPage } from "./pages/resources/GuardrailsPage";
import { SkillDetailPage } from "./pages/resources/SkillDetailPage";
import { SkillsPage } from "./pages/resources/SkillsPage";
import { PluginsPage } from "./pages/resources/PluginsPage";

export { api };

export const NAV: NavEntry[] = [
  { label: "Overview", to: "/", description: "Agents, active sessions, pending approvals and recent activity at a glance." },
  { label: "Agents", to: "/agents", description: "Every agent on this deployment, its mandates and who can reach it.", keywords: "personas" },
  { label: "Sessions", to: "/sessions", description: "Live and recent conversations, with a timeline you can step into.", keywords: "threads" },
  { label: "Approvals and audit", to: "/audit", description: "Every permission decision and console change, newest first.", keywords: "log history" },
  { label: "Access", to: "/access", description: "Console roles and the grants that decide who can work with each agent.", keywords: "grants roles" },
  { label: "Users", to: "/users", description: "People and bots the deployment knows and how each was matched (superadmin, read only).", keywords: "people bindings identity accounts" },
  { label: "Merges", to: "/merges", description: "Records joined into one person, what each merge moved, and undo for seven days (superadmin).", keywords: "undo identity accounts people" },
  { label: "Proposals", to: "/proposals", description: "Pairs of records the system would not merge by itself, for an operator to approve or dismiss (superadmin).", keywords: "merge conflict identity people" },
  { label: "Boundaries", to: "/boundaries", description: "Channels and groups the deployment knows (superadmin, read only).", keywords: "channels groups" },
  { label: "Memory", to: "/memory", description: "Browse the memory stores your agents read and write.", keywords: "brain pages stores" },
  { label: "Environments", to: "/environments", description: "Where agents run: node pools, placement and personal environments.", keywords: "nodes" },
  { label: "Skills", to: "/skills", group: "Resources", description: "Every skill your agents can use, where it came from and how often it is used.", keywords: "plugins resources" },
  { label: "Guardrails", to: "/guardrails", group: "Resources", description: "The rules you set for your agents: enforced tool and message rules, and Guidance they read.", keywords: "policy rules limits resources" },
  { label: "Plugins", to: "/plugins", group: "Resources", description: "Plugins each node image carries, by node label, and the state of their MCP servers.", keywords: "mcp servers commits resources" },
];

/** GET /panel/auth/me answers { email, role } for the signed-in operator. */
interface PanelMe {
  email: string;
  role: "superadmin" | "operator";
}

const ROLE_LABEL: Record<PanelMe["role"], string> = { superadmin: "Superadmin", operator: "Operator" };

async function loadIdentity(): Promise<Identity> {
  const me = await api.get<PanelMe>("/auth/me");
  return { name: me.email, detail: ROLE_LABEL[me.role] ?? me.role, role: me.role };
}

function renderPage(path: string, entry: NavEntry | null) {
  if (path === "/") return <OverviewPage />;
  if (path === "/agents") return <AgentsPage />;
  if (path === "/access") return <AccessPage />;
  if (path === "/sessions") return <SessionsPage />;
  if (path === "/audit") return <AuditPage />;
  if (path === "/users") return <UsersPage />;
  if (path === "/merges") return <MergesPage />;
  if (path === "/proposals") return <ProposalsPage />;
  if (path === "/boundaries") return <BoundariesPage />;
  if (path === "/memory") return <MemoryStoresPage />;
  if (path === "/environments") return <EnvironmentsPage />;
  if (path === "/skills") return <SkillsPage />;
  if (path === "/plugins") return <PluginsPage />;
  if (path === "/guardrails") return <GuardrailsPage />;
  const skill = matchPath("/skills/:id", path);
  if (skill) return <SkillDetailPage key={skill.id} id={skill.id!} />;
  if (path.startsWith("/skills/")) return <NotFoundPage home="/skills" />;
  if (path === "/guardrails/new") return <GuardrailEditPage key="new" />;
  if (path === "/guardrails/test") return <GuardrailTestPage />;
  // Any guardrail by name, even one stored as "new" or "test" (no name contains "~").
  const byNameEdit = matchPath("/guardrails/~/:slug/edit", path);
  if (byNameEdit) return <GuardrailEditPage key={`edit:${byNameEdit.slug}`} slug={byNameEdit.slug!} />;
  const byName = matchPath("/guardrails/~/:slug", path);
  if (byName) return <GuardrailDetailPage key={byName.slug} slug={byName.slug!} />;
  const editGuardrail = matchPath("/guardrails/:slug/edit", path);
  if (editGuardrail) return <GuardrailEditPage key={`edit:${editGuardrail.slug}`} slug={editGuardrail.slug!} />;
  const guardrail = matchPath("/guardrails/:slug", path);
  if (guardrail) return <GuardrailDetailPage key={guardrail.slug} slug={guardrail.slug!} />;
  if (path.startsWith("/guardrails/")) return <NotFoundPage home="/guardrails" />;
  const session = matchPath("/sessions/:id", path) ?? matchPath("/sessions/:id/:tab", path);
  if (session) {
    const tab = session.tab ?? "timeline";
    if (isSessionTab(tab)) return <SessionDetailPage key={session.id} id={session.id!} tab={tab} />;
  }
  if (path.startsWith("/sessions/")) return <NotFoundPage home="/sessions" />;
  const memPage = matchPath("/memory/:store/page", path);
  if (memPage) return <MemoryPageView key={memPage.store} storeId={memPage.store!} />;
  const store = matchPath("/memory/:store", path);
  if (store) return <MemoryStorePage key={store.store} storeId={store.store!} />;
  if (path.startsWith("/memory/")) return <NotFoundPage home="/memory" />;
  const agent = matchPath("/agents/:name", path) ?? matchPath("/agents/:name/:tab", path);
  if (agent) {
    const tab = agent.tab ?? "overview";
    if (isAgentTab(tab)) return <AgentDetailPage key={agent.name} name={agent.name!} tab={tab} />;
  }
  if (path.startsWith("/agents/")) return <NotFoundPage home="/agents" />;
  return entry ? <PlaceholderPage entry={entry} /> : <NotFoundPage home="/" />;
}

export function App() {
  return (
    <AppFrame product="console" sidebarTitle="Console" nav={NAV} api={api} loadIdentity={loadIdentity} renderPage={renderPage} />
  );
}
