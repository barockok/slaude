#!/usr/bin/env bash
# Run a mock OAuth-protected MCP server in the local cluster and register it in
# the agent's .mcp.json, so the portal's "connect" flow has something to connect
# to. Needs panel.sh to have run. The server's public name is
# mockmcp.localtest.me (resolves to 127.0.0.1 on the host); the gateway pods get
# a hostAlias for it.
set -euo pipefail
NS=slaude-scale
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

kubectl -n $NS create configmap mock-mcp-src --from-file=server.ts="$HERE/server.ts" --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$HERE/mock-mcp.yaml"
kubectl -n $NS rollout status deploy/mock-mcp --timeout=300s

IP="$(kubectl -n $NS get svc mock-mcp -o jsonpath='{.spec.clusterIP}')"
if ! kubectl -n $NS get deploy slaude-gateway -o jsonpath='{.spec.template.spec.hostAliases[*].hostnames[*]}' | grep -q mockmcp.localtest.me; then
  kubectl -n $NS patch deploy/slaude-gateway --type json -p \
    "[{\"op\":\"add\",\"path\":\"/spec/template/spec/hostAliases/-\",\"value\":{\"ip\":\"$IP\",\"hostnames\":[\"mockmcp.localtest.me\"]}}]"
  kubectl -n $NS rollout status deploy/slaude-gateway --timeout=300s
fi

kubectl -n $NS exec -i deploy/slaude-gateway -- sh -c 'cat > /data/.mcp.json' <<'JSON'
{ "mcpServers": { "mockmcp": { "type": "http", "url": "http://mockmcp.localtest.me:9000/mcp" } } }
JSON
cat <<MSG

Mock MCP ready. Keep this running too:
  kubectl -n $NS port-forward svc/mock-mcp 9000:9000
The portal (http://localhost:8080/portal) should now list "mockmcp".
MSG
