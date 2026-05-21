# slaude — single-persona Slack-native Claude Code runtime.
# One container = one bot user = one SOUL.md.

FROM oven/bun:1.3-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Builder stage: install agent dependencies declared in slaude.json,
# then copy the artifacts into the runtime image.
FROM oven/bun:1.3-debian AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
ENV SLAUDE_HOME=/app/.slaude
RUN mkdir -p $SLAUDE_HOME/skills $SLAUDE_HOME/knowledge $SLAUDE_HOME/.claude
RUN bun run install-deps --frozen

FROM oven/bun:1.3-debian
WORKDIR /app

# claude-agent-sdk spawns the bundled `claude` CLI which needs Node-runtime
# build deps (git, ca-certs) and the user code mounts $SLAUDE_HOME for
# persistent state.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -LsSf https://astral.sh/uv/install.sh | sh \
 && mv /root/.local/bin/uv /root/.local/bin/uvx /usr/local/bin/ \
 && uvx --version \
 && uvx --from mcp-grafana mcp-grafana --help > /dev/null

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Baked-in dependency artifacts (plugins, skills, knowledge bases).
# Operator-authored files (slaude.json, slaude.lock, mcp.json, SOUL.md)
# are mounted from the PVC at runtime.
COPY --from=builder /app/.slaude/skills    /data/.slaude/skills
COPY --from=builder /app/.slaude/knowledge /data/.slaude/knowledge
COPY --from=builder /app/.slaude/.claude   /data/.slaude/.claude

ENV SLAUDE_HOME=/data
VOLUME ["/data"]

# The container reads SLACK_*, ANTHROPIC_*, SLAUDE_MODEL from env (or /data/.env).
# SOUL.md lives at /data/SOUL.md — bake it into the image OR mount per deploy.

CMD ["bun", "run", "start"]
