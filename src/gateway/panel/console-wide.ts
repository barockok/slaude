/**
 * Which audit events are about the console or the deployment, not one agent
 * (sign-in, console roles, a config reload, an owner guardrail write). Shared by the panel's audit
 * mapping (it records them with persona null) and the console (it shows them
 * as Console, older rows written under the default agent included), so the
 * two cannot drift. Pure, no imports: the web build includes it.
 */

/** A panel action name (before mapping), e.g. `auth.login`, `console.roles.read`, `reload`. */
export function isConsoleWidePanelAction(action: string): boolean {
  return action.startsWith("auth.") || action.startsWith("console.") || action.startsWith("guardrail.") || action === "reload";
}

/** A recorded audit action, e.g. `panel.auth.login`, `panel.console.roles.read`, `panel.config.reload`. */
export function isConsoleWideAuditAction(action: string): boolean {
  return action.startsWith("panel.auth.") || action.startsWith("panel.console.") || action.startsWith("panel.guardrail.") || action === "panel.config.reload";
}
