<!-- docs-new/_sidebar.md — navigation stub for docs-new site (docsify / VitePress / Docusaurus compatible) -->
<!-- Ordered to mirror Next.js docs hierarchy: hero → grouped sections → reference → ops -->

- **Overview**
  - [Introduction](index.md)
  - [Getting Started](getting-started/index.md)

- **Getting Started**
  - [Quickstart (5 min)](getting-started/index.md#quickstart-5-minutes)
  - [Prerequisites](getting-started/index.md#prerequisites)
  - [Verify Installation](getting-started/index.md#verify-installation)
  - [Next Steps](getting-started/index.md#next-steps)

- **Installation & Configuration**
  - [Overview](installation/index.md)
  - [Environment Variables](installation/index.md#environment)
  - [Slack App Manifest](installation/index.md#slack-app)
  - [Provider & Model Selection](installation/index.md#provider-and-model)
  - [SOUL.md Schema](installation/index.md#soulmd)

- **Architecture**
  - [Overview](architecture/index.md)
  - [Session Lifecycle](architecture/index.md#session-lifecycle)
  - [Gateway — Trust Boundary](architecture/index.md#trust-boundary)
  - [Agent Runtime](architecture/index.md#agent-runtime)
  - [Persistence (sqlite + PVC)](architecture/index.md#persistence)
  - [Diagram](architecture/index.md#diagram)

- **Guides**
  - [Overview](guides/index.md)
  - [SOUL & Persona](guides/soul.md)
  - [Engagement Model](guides/engagement.md)
  - [Approvals](guides/engagement.md#approvals)
  - [Slash Commands](guides/commands.md)
  - [Skills & Evolution](guides/skills.md)
  - [Knowledge Bases & Ingest](guides/skills.md#knowledge-bases)
  - [Brain (gbrain)](guides/brain.md)
  - [External MCP Servers](guides/mcp.md)
  - [Contextual Connections](guides/connections.md)
  - [Cron & Scheduling](guides/cron.md)

- **API & Reference**
  - [Overview](api/index.md)
  - [MCP — slaude_slack](api/index.md#mcp-slaude-slack)
  - [MCP — slaude_skills](api/index.md#mcp-slaude-skills)
  - [MCP — slaude_kb / brain](api/index.md#mcp-slaude-kb)
  - [MCP — slaude_connect](api/index.md#mcp-slaude-connect)
  - [CLI Commands](api/index.md#cli)
  - [Manifest Schemas](api/index.md#schemas)
  - [Metrics](api/index.md#metrics)

- **Deployment & Operations**
  - [Overview](deployment/index.md)
  - [Docker Compose](deployment/index.md#docker)
  - [Multi-Node (gateway + workers)](deployment/multi-node.md)
  - [Kubernetes](deployment/index.md#kubernetes)
  - [Health & Readiness](deployment/index.md#health)
  - [Prometheus Metrics](deployment/index.md#metrics)
  - [Simulation Gateway](deployment/index.md#simulation)
  - [Logging & Troubleshooting](deployment/index.md#troubleshooting)

- **Examples**
  - [Overview](examples/index.md)
  - [First Skill](examples/index.md#first-skill)
  - [First KB Ingest](examples/index.md#first-ingest)
  - [Custom MCP Server](examples/index.md#custom-mcp)
  - [Multi-Persona](examples/index.md#multi-persona)

- **Project**
  - [Releases](../docs/releases/v0.41.0.md)
  - [Findings](../docs/findings/)
  - [Contributing](../CONTRIBUTING.md)
  - [Security](../SECURITY.md)
  - [GitHub](https://github.com/barockok/slaude)
