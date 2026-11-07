/**
 * A tiny history router. Paths inside the app are written without the mount
 * base ("/agents/ravi"); the base ("/panel" or "/portal") is added on the way
 * out and stripped on the way in.
 */
import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

let base = "";
const listeners = new Set<() => void>();

/** Set once at startup: "/panel" or "/portal". */
export function setBase(b: string): void {
  base = b.replace(/\/+$/, "");
}

export function href(to: string): string {
  return base + (to.startsWith("/") ? to : `/${to}`);
}

function currentPath(): string {
  const p = location.pathname;
  const rel = p === base ? "/" : p.startsWith(`${base}/`) ? p.slice(base.length) : p;
  return rel.length > 1 ? rel.replace(/\/+$/, "") : "/";
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("popstate", cb);
  return () => void (listeners.delete(cb), window.removeEventListener("popstate", cb));
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = href(to);
  history[opts.replace ? "replaceState" : "pushState"](null, "", url);
  for (const cb of listeners) cb();
  window.scrollTo(0, 0);
}

/** Match "/agents/:name" against a path; params are URI-decoded. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split("/").filter(Boolean);
  const xs = path.split("/").filter(Boolean);
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!, x = xs[i]!;
    if (!p.startsWith(":")) {
      if (p !== x) return null;
      continue;
    }
    try { params[p.slice(1)] = decodeURIComponent(x); } catch { return null; }
  }
  return params;
}

export type Route<P extends string> = { path: string; pattern: P | null; params: Record<string, string> };

/** The current path and the first pattern that matches it. */
export function useRoute<P extends string>(patterns: readonly P[]): Route<P> {
  const path = useSyncExternalStore(subscribe, currentPath);
  for (const pattern of patterns) {
    const params = matchPath(pattern, path);
    if (params) return { path, pattern, params };
  }
  return { path, pattern: null, params: {} };
}

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string };

/** An anchor that navigates in-app on a plain left click and behaves normally otherwise. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
    e.preventDefault();
    navigate(to);
  };
  return createElement("a", { ...rest, href: href(to), onClick: handle });
}
