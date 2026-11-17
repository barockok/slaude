/**
 * The frame both apps share: shell, sidebar nav, top-bar search over the nav,
 * user menu, toasts, the signed-in identity, and the dev-only gallery route.
 * Each app supplies its nav, how to load "me", and how to render a page.
 */
import { createContext, Fragment, lazy, Suspense, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, AuthRedirectError, type ApiClient } from "../lib/api";
import { navigate, useRoute } from "../lib/router";
import {
  AppShell, Button, DocsLink, EmptyState, JumpSearch, NavGroup, NavItem, Sidebar, ToastProvider, UserMenu, Mark,
} from "../ui";

export const DOCS_URL = "https://barockok.github.io/slaude/";

export interface NavEntry {
  label: string;
  /** In-app path; also the prefix that marks the entry active. */
  to: string;
  description: string;
  keywords?: string;
  /** A heading the entry sits under in the sidebar (consecutive entries share it). */
  group?: string;
}

export interface Identity {
  name: string;
  detail?: string;
  /** App-specific role key, e.g. "superadmin" or "operator" in the console. */
  role?: string;
}

const IdentityContext = createContext<Identity | null>(null);

/** The signed-in identity, or null while it loads. */
export function useIdentity(): Identity | null {
  return useContext(IdentityContext);
}

export interface AppFrameProps {
  product: string;
  sidebarTitle: string;
  nav: NavEntry[];
  api: ApiClient;
  loadIdentity: () => Promise<Identity>;
  /** Renders the page for the current path and its nav entry (null when none matches). */
  renderPage: (path: string, entry: NavEntry | null) => ReactNode;
}

// The gallery is a dev aid; production builds drop it (and its chunk) entirely.
const Gallery = import.meta.env.DEV ? lazy(() => import("../ui/Gallery")) : null;

function activeEntry(nav: NavEntry[], path: string): NavEntry | null {
  let best: NavEntry | null = null;
  for (const n of nav) {
    const hit = n.to === "/" ? path === "/" : path === n.to || path.startsWith(`${n.to}/`);
    if (hit && (!best || n.to.length > best.to.length)) best = n;
  }
  return best;
}

type IdentityState = { status: "loading" } | { status: "ok"; identity: Identity } | { status: "error"; error: ApiError | Error };

export function AppFrame({ product, sidebarTitle, nav, api, loadIdentity, renderPage }: AppFrameProps) {
  const { path } = useRoute([] as string[]);
  const [state, setState] = useState<IdentityState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    loadIdentity().then(
      (identity) => setState({ status: "ok", identity }),
      (error: Error) => {
        // The browser is already on its way to sign in; keep showing the shell.
        if (error instanceof AuthRedirectError) return;
        setState({ status: "error", error });
      },
    );
  }, [loadIdentity]);

  useEffect(load, [load]);

  const signOut = () => void api.signOut();

  if (state.status === "error") {
    const forbidden = state.error instanceof ApiError && state.error.status === 403;
    return (
      <div className="sl-center">
        <div className="sl-center__box">
          <EmptyState
            icon={<Mark size={20} />}
            title={forbidden ? "You do not have access" : "Something went wrong"}
            description={
              forbidden
                ? "Your account is signed in but is not on this console's role list. Ask an administrator to add you."
                : state.error.message
            }
            action={
              forbidden ? (
                <Button onClick={signOut}>Sign out</Button>
              ) : (
                <Button onClick={load}>Try again</Button>
              )
            }
          />
        </div>
      </div>
    );
  }

  const entry = activeEntry(nav, path);
  const identity = state.status === "ok" ? state.identity : null;
  const isGallery = Gallery !== null && path === "/_gallery";

  return (
    <IdentityContext.Provider value={identity}>
      <ToastProvider>
        <AppShell
          product={product}
          routeKey={path}
          search={
            <JumpSearch
              placeholder={`Search ${product}...`}
              targets={nav.map((n) => ({ label: n.label, to: n.to, keywords: n.keywords }))}
              onGo={(to) => navigate(to)}
            />
          }
          topActions={<DocsLink href={DOCS_URL} />}
          user={<UserMenu name={identity?.name ?? null} detail={identity?.detail} onSignOut={signOut} />}
          sidebar={
            <Sidebar title={sidebarTitle} label={`${sidebarTitle} navigation`}>
              {nav.map((n, i) => (
                <Fragment key={n.to}>
                  {n.group && n.group !== nav[i - 1]?.group && <NavGroup label={n.group} />}
                  <NavItem to={n.to} active={!isGallery && entry?.to === n.to}>
                    {n.label}
                  </NavItem>
                </Fragment>
              ))}
              {Gallery && (
                <NavItem to="/_gallery" active={isGallery}>
                  Component gallery
                </NavItem>
              )}
            </Sidebar>
          }
        >
          {isGallery && Gallery ? (
            <Suspense fallback={null}>
              <Gallery />
            </Suspense>
          ) : (
            renderPage(path, entry)
          )}
        </AppShell>
      </ToastProvider>
    </IdentityContext.Provider>
  );
}
