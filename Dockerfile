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

# tailcat: SSH transport for /remote (runs a thread's tools on the user's machine).
# The release archive holds the binary at its root next to LICENSE and README.md.
# The pins are the SHA-256 of the release archives (from the release's
# checksums.txt); bumping TAILCAT_VERSION requires updating both hashes.
ARG TAILCAT_VERSION=0.7.0
ARG TAILCAT_SHA256_AMD64=23c0b1887a5ec422f0d18a9c52b4f5357815febdaae738a1eb54036d10bd9ee6
ARG TAILCAT_SHA256_ARM64=bbb1ab50f24f00effe1e1fd86d0501803fb80793a90785a2a16ff3428f03d8ef
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sha="$TAILCAT_SHA256_AMD64" ;; \
      arm64) sha="$TAILCAT_SHA256_ARM64" ;; \
      *) echo "unsupported architecture for tailcat: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/tailcat.tgz "https://github.com/tailscale/tailcat/releases/download/v${TAILCAT_VERSION}/tailcat_${TAILCAT_VERSION}_linux_${arch}.tar.gz"; \
    echo "${sha}  /tmp/tailcat.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tailcat.tgz -C /usr/local/bin tailcat; \
    rm -f /tmp/tailcat.tgz; \
    test -x /usr/local/bin/tailcat

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
# Bundled skills that ship with the product. seedBundledSkills() copies any
# missing slug into $SLAUDE_HOME/skills on boot — robust against a mounted PVC
# shadowing the baked-in /data/.slaude/skills below.
COPY skills ./skills
COPY scripts ./scripts

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
