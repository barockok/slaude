# The default box: the image a boxed session runs on when its persona says
# `box: default` (or the gateway sets SLAUDE_BOX_DEFAULT=default) and the
# deploy repository defines no box of that name.
#
# It carries what the slaude image carries for an unboxed agent today (git,
# curl, CA certificates, bun, uv), so a persona that opts in sees the same
# tools. It holds no credential and no token, and must never be given one: a
# box holds no secret.
#
# What a node requires of any box image (it checks them when it unpacks one):
# Linux with glibc, an `agent` user with uid and gid 10001, /home/agent, git,
# and CA certificates. Nothing else of the image's configuration is used: not
# its USER, not its ENTRYPOINT, and of its ENV only PATH. Every other variable
# a box needs is in box.yaml (`env`), which is why the package-manager settings
# appear in both places: here for `docker run`, there for a box.
#
# Published by .github/workflows/docker.yml and release.yml, one image per
# architecture. To change the tools of your own agents, copy this directory to
# `boxes/<name>/` in your deploy repository and edit it there.
FROM oven/bun:1.3-debian AS bun

FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# bun, from the same image the slaude runtime is built on.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx && bun --version

# uv and uvx, installed the way the slaude image installs them.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
 && mv /root/.local/bin/uv /root/.local/bin/uvx /usr/local/bin/ \
 && uvx --version

# The agent user. The uid and gid are fixed: a node hands a session's files to 10001.
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent --shell /bin/bash agent

# Package managers install into the home, which is durable, never into system
# directories: under gVisor the agent cannot write those at all, and on any
# tier a system-level write is thrown away when the sandbox stops.
#   npm: a user-level prefix (also in /etc/npmrc, for a tool that drops the environment);
#   pip: user installs (inside a virtualenv pip refuses them: use `uv pip`, or PIP_USER=0 for that command);
#   go:  GOPATH in the home;
#   bun and uv already keep their caches and global installs under the home.
RUN printf 'prefix=/home/agent/.npm-global\n' > /etc/npmrc
ENV NPM_CONFIG_PREFIX=/home/agent/.npm-global \
    PIP_USER=1 \
    GOPATH=/home/agent/go \
    BUN_INSTALL=/home/agent/.bun \
    UV_CACHE_DIR=/home/agent/.cache/uv \
    UV_TOOL_BIN_DIR=/home/agent/.local/bin \
    PATH=/home/agent/.local/bin:/home/agent/.bun/bin:/home/agent/.npm-global/bin:/home/agent/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# What a new session's home starts from. A node copies the image's /home/agent
# into an empty home once; after that the home is the session's own.
RUN mkdir -p /home/agent/.local/bin /home/agent/.npm-global /home/agent/.bun/bin /home/agent/.cache /home/agent/go \
 && chown -R 10001:10001 /home/agent

USER agent
WORKDIR /home/agent
CMD ["/bin/bash"]
