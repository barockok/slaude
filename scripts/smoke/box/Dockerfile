# The box image the smoke test and the tier-gated suites run on. Not a product image: the default
# box (boxes/default) is a later phase. It holds only what a box must have (src/box/image.ts,
# rootfsProblems): glibc, an `agent` user with uid and gid 10001, /home/agent, git, CA certificates.
# curl and procps are for the assertions (a refused request, a process listing).
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 agent \
 && useradd -u 10001 -g 10001 -m -d /home/agent -s /bin/bash agent \
 && echo "seeded from the image" > /home/agent/.box-seed \
 && chown agent:agent /home/agent/.box-seed
USER agent
WORKDIR /home/agent
