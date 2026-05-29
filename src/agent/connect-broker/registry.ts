export type ToolFlags = {
  /** Must run as the caller's own identity; never falls back to slaude/borrow silently. */
  personal: boolean;
  /** May be invoked under another user's connection (with a grant). */
  borrowable: boolean;
  /** Mutating call — always routed through PermissionGate + hash-bound approval. */
  write: boolean;
};

export type ServiceDef = {
  service: string;
  auth_strategy: "token" | "cookie";
  /** Domain the login flow must reach; used by login capture + egress allowlist. */
  loginUrl: string;
  /** How to spawn the vendor MCP child. Credential is delivered via stdin (never argv/env). */
  spawn: { command: string; args: string[] };
  /** Per-tool flag overrides. Tools not listed get FAIL_CLOSED. */
  tools: Record<string, ToolFlags>;
};

const FAIL_CLOSED: ToolFlags = { personal: true, borrowable: false, write: true };

const SERVICES: Record<string, ServiceDef> = {
  jira: {
    service: "jira",
    auth_strategy: "token",
    loginUrl: "https://id.atlassian.com/login",
    spawn: { command: "npx", args: ["-y", "@modelcontextprotocol/server-jira"] },
    tools: {
      jira_search:         { personal: true, borrowable: true, write: false },
      jira_get_issue:      { personal: true, borrowable: true, write: false },
      jira_list_my_issues: { personal: true, borrowable: false, write: false },
      jira_create_issue:   { personal: true, borrowable: false, write: true },
      jira_update_issue:   { personal: true, borrowable: false, write: true },
      jira_delete_issue:   { personal: true, borrowable: false, write: true },
      jira_add_comment:    { personal: true, borrowable: false, write: true },
    },
  },
};

export function getService(service: string): ServiceDef | null {
  return SERVICES[service] ?? null;
}

export function listServices(): string[] {
  return Object.keys(SERVICES);
}

export function toolFlags(service: string, tool: string): ToolFlags {
  const def = SERVICES[service];
  if (!def) return { ...FAIL_CLOSED };
  return def.tools[tool] ?? { ...FAIL_CLOSED };
}
