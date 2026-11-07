/**
 * The return from an integration's sign-in. /portal/oauth/callback redirects to
 * `/portal?connect=<result>`; this reads the result once, shows it as a toast,
 * and moves to the integrations page with the query dropped, so a reload or
 * Back does not repeat it.
 */
import { useEffect } from "react";
import { navigate } from "../lib/router";
import { useToast } from "../ui";
import { CONNECT_RESULT, isConnectResult } from "./lib/labels";

// Read at load, before anything rewrites the URL; consumed once per page load
// (StrictMode runs effects twice in dev).
let pending: string | null = new URLSearchParams(location.search).get("connect");

export function ConnectReturn() {
  const toast = useToast();
  useEffect(() => {
    const result = pending;
    if (result === null) return;
    pending = null;
    const copy = isConnectResult(result)
      ? CONNECT_RESULT[result]
      : { tone: "danger" as const, title: "Connection did not complete", description: "Try connecting again." };
    toast(copy);
    navigate("/integrations", { replace: true });
  }, [toast]);
  return null;
}
