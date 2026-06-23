# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Email **zidmubarock@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version / commit.

You'll get an acknowledgement within a few days. Coordinated disclosure is
appreciated — give us a reasonable window to ship a fix before going public.

## Scope

slaude is a Slack-native runtime that drives Claude Code with broad tool
access (shell, MCP servers, file system). Of particular interest:

- **Secret/credential exposure** — tokens, OAuth material, or env values
  leaking into Slack messages, logs, the status line, or the knowledge base.
- **Permission/approval bypass** — actions running without the approval gate,
  or escalation past a SOUL.md/channel ACL.
- **Prompt-injection → tool execution** — untrusted Slack/KB content steering
  the agent into unauthorized tool calls.
- **MCP OAuth** — token leakage or cross-session/cross-user confusion in the
  shared loopback or per-initiator flows.

## Handling secrets

This is a public repository. Never include real tokens, internal hostnames,
internal Slack channel/user IDs, or operator-deployment details in issues,
PRs, or reports — use placeholders. If you find such data already committed,
report it privately via the email above.
