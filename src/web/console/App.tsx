/**
 * The operator console, served at /panel: shell, navigation and the page for
 * each route. Pages not built yet render a placeholder.
 */
import { AppFrame, type Identity, type NavEntry } from "../shared/AppFrame";
import { NotFoundPage, PlaceholderPage } from "../shared/PlaceholderPage";
import { api } from "./client";
import { OverviewPage } from "./pages/OverviewPage";

export { api };

export const NAV: NavEntry[] = [
  { label: "Overview", to: "/", description: "Agents, live sessions, pending approvals and recent activity at a glance." },
  { label: "Agents", to: "/agents", description: "Every agent on this deployment, its mandates and who can reach it.", keywords: "personas" },
  { label: "Sessions", to: "/sessions", description: "Live and recent conversations, with a timeline you can step into.", keywords: "threads" },
  { label: "Approvals and audit", to: "/audit", description: "Every permission decision and console change, newest first.", keywords: "log history" },
  { label: "Access", to: "/access", description: "Console roles and the grants that decide who can work with each agent.", keywords: "grants roles" },
  { label: "Memory", to: "/memory", description: "Browse the memory stores your agents read and write.", keywords: "brain pages stores" },
  { label: "Environments", to: "/environments", description: "Where agents run: node pools, placement and personal environments.", keywords: "nodes" },
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
  return entry ? <PlaceholderPage entry={entry} /> : <NotFoundPage home="/" />;
}

export function App() {
  return (
    <AppFrame product="console" sidebarTitle="Console" nav={NAV} api={api} loadIdentity={loadIdentity} renderPage={renderPage} />
  );
}
