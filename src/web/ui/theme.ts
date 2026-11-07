/**
 * Theme preference: "system" follows prefers-color-scheme (tokens.css handles
 * it), "light" and "dark" pin it with data-theme on <html>. Persisted per
 * browser; storage can throw (private windows, blocked site data), so every
 * access is guarded and the page still works without it.
 */
export type ThemePref = "system" | "light" | "dark";

const KEY = "slaude.theme";

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function saveThemePref(pref: ThemePref): void {
  applyThemePref(pref);
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
}
