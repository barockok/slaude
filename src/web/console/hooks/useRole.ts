import { useIdentity } from "../../shared/AppFrame";

export type ConsoleRole = "superadmin" | "operator";

/** The signed-in operator's console role, or null while it loads. */
export function useRole(): ConsoleRole | null {
  const role = useIdentity()?.role;
  return role === "superadmin" || role === "operator" ? role : null;
}
