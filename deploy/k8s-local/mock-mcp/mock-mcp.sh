#!/usr/bin/env bash
# Run a mock OAuth-protected MCP server in the local cluster and register it in
# the agent's .mcp.json, so the portal's "connect" flow has something to connect
# to. Needs panel.sh to have run. The server's public name is
# mockmcp.localtest.me (resolves to 127.0.0.1 on the host); the gateway pods get
# a hostAlias for it.
set -euo pipefail
NS=slaude-scale
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}" # the kubectl context; never the current one
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The server's public name and the Service both say 9000, so the local port is
# checked rather than applied (forward.sh mock-mcp reads the same variable).
if [[ "${SLAUDE_LOCAL_MOCK_MCP_PORT:-9000}" != 9000 ]]; then
  echo "mock-mcp.sh: SLAUDE_LOCAL_MOCK_MCP_PORT must be 9000; the registered URL and the Service are fixed there." >&2
  exit 1
fi

kubectl --context "$PROFILE" -n $NS create configmap mock-mcp-src --from-file=server.ts="$HERE/server.ts" --dry-run=client -o yaml | kubectl --context "$PROFILE" apply -f -
kubectl --context "$PROFILE" apply -f "$HERE/mock-mcp.yaml"
kubectl --context "$PROFILE" -n $NS rollout status deploy/mock-mcp --timeout=300s

IP="$(kubectl --context "$PROFILE" -n $NS get svc mock-mcp -o jsonpath='{.spec.clusterIP}')"
if ! kubectl --context "$PROFILE" -n $NS get deploy slaude-gateway -o jsonpath='{.spec.template.spec.hostAliases[*].hostnames[*]}' | grep -q mockmcp.localtest.me; then
  kubectl --context "$PROFILE" -n $NS patch deploy/slaude-gateway --type json -p \
    "[{\"op\":\"add\",\"path\":\"/spec/template/spec/hostAliases/-\",\"value\":{\"ip\":\"$IP\",\"hostnames\":[\"mockmcp.localtest.me\"]}}]"
  kubectl --context "$PROFILE" -n $NS rollout status deploy/slaude-gateway --timeout=300s
fi

kubectl --context "$PROFILE" -n $NS exec -i deploy/slaude-gateway -- sh -c 'cat > /data/.mcp.json' <<'JSON'
{ "mcpServers": { "mockmcp": { "type": "http", "url": "http://mockmcp.localtest.me:9000/mcp" } } }
JSON
cat <<MSG

Mock MCP ready. Keep this running too:
  $HERE/../forward.sh mock-mcp
The portal (http://localhost:${SLAUDE_LOCAL_PORT:-8080}/portal) should now list "mockmcp".
MSG
