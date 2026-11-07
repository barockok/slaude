/**
 * The personal portal, served at /portal. This change lays down the shell and
 * the navigation; each page is filled in by a later change.
 */
import { createApi } from "../lib/api";
import { AppFrame, type Identity, type NavEntry } from "../shared/AppFrame";
import { NotFoundPage, PlaceholderPage } from "../shared/PlaceholderPage";

export const api = createApi("portal");

export const NAV: NavEntry[] = [
  { label: "My account", to: "/", description: "Your sign-in and the Slack identities linked to it.", keywords: "slack identity" },
  { label: "Integrations", to: "/integrations", description: "Connect the tools your agents use on your behalf.", keywords: "connect oauth" },
  { label: "My agents", to: "/agents", description: "Agents you can work with, and your role on each.", keywords: "grants" },
];

/** GET /portal/api/me answers the signed-in account and its Slack identities. */
interface PortalMe {
  email: string;
  accountId: string;
  slackIdentities: Array<{ teamId: string; slackUserId: string; linkedAt: number }>;
}

async function loadIdentity(): Promise<Identity> {
  const me = await api.get<PortalMe>("/api/me");
  const n = me.slackIdentities.length;
  return { name: me.email, detail: n === 0 ? "No Slack identity linked" : n === 1 ? "1 Slack identity linked" : `${n} Slack identities linked` };
}

export function App() {
  return (
    <AppFrame
      product="portal"
      sidebarTitle="Portal"
      nav={NAV}
      api={api}
      loadIdentity={loadIdentity}
      renderPage={(_path, entry) => (entry ? <PlaceholderPage entry={entry} /> : <NotFoundPage home="/" />)}
    />
  );
}
