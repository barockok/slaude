/**
 * The personal portal, served at /portal, for every person on the deployment:
 * their sign-in and linked Slack identities, the integrations they connect for
 * agents to use on their behalf, and the agents they can work with.
 */
import type { PortalMeResponse } from "../../gateway/portal/api-types";
import { AppFrame, type Identity, type NavEntry } from "../shared/AppFrame";
import { NotFoundPage, PlaceholderPage } from "../shared/PlaceholderPage";
import { api } from "./client";
import { ConnectReturn } from "./ConnectReturn";
import { AccountPage } from "./pages/AccountPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";

export { api };

export const NAV: NavEntry[] = [
  { label: "My account", to: "/", description: "Your sign-in and the Slack identities linked to it.", keywords: "slack identity link unlink" },
  { label: "Integrations", to: "/integrations", description: "Connect the tools your agents use on your behalf.", keywords: "connect oauth disconnect" },
  { label: "My agents", to: "/agents", description: "Agents you can work with, and your role on each.", keywords: "grants roles" },
];

async function loadIdentity(): Promise<Identity> {
  const me = await api.get<PortalMeResponse>("/api/me");
  const n = me.slackIdentities.length;
  return { name: me.email, detail: n === 0 ? "No Slack identity linked" : n === 1 ? "1 Slack identity linked" : `${n} Slack identities linked` };
}

function page(path: string) {
  switch (path) {
    case "/":
      return <AccountPage />;
    case "/integrations":
      return <IntegrationsPage />;
    case "/agents":
      return <PlaceholderPage entry={NAV[2]!} />;
    default:
      return <NotFoundPage home="/" />;
  }
}

export function App() {
  return (
    <AppFrame
      product="portal"
      sidebarTitle="Portal"
      nav={NAV}
      api={api}
      loadIdentity={loadIdentity}
      renderPage={(path) => (
        <>
          <ConnectReturn />
          {page(path)}
        </>
      )}
    />
  );
}
