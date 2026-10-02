#!/usr/bin/env bash
# Enable the panel + portal on the local cluster, with an in-cluster Keycloak as
# the OIDC provider. Run after up.sh. up.sh re-applies the stock overlay, so
# re-run this after any up.sh.
#
# The issuer is http://keycloak.localtest.me:8180. That public wildcard name
# resolves to 127.0.0.1 on your Mac (no /etc/hosts edit), and the gateway pods
# get a hostAlias pointing it at the Keycloak Service. Then port-forward
# svc/keycloak 8180 and svc/slaude-gateway 8080 (printed below).
set -euo pipefail
NS=slaude-scale
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REALM="$HERE/../../dev/keycloak/slaude-dev-realm.json"
PUBLIC=http://localhost:8080

# The dev realm registers only the panel callback; add the portal's.
python3 - "$REALM" <<'PY' | kubectl -n $NS create configmap keycloak-realm --from-file=slaude-dev-realm.json=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
import json, sys
r = json.load(open(sys.argv[1]))
for c in r["clients"]:
    if c["clientId"] == "slaude-panel":
        c["redirectUris"].append("http://localhost:8080/portal/auth/callback")
print(json.dumps(r))
PY
kubectl apply -f "$HERE/keycloak.yaml"
kubectl -n $NS rollout status deploy/keycloak --timeout=600s

KC_IP="$(kubectl -n $NS get svc keycloak -o jsonpath='{.spec.clusterIP}')"
kubectl -n $NS patch deploy/slaude-gateway --type merge -p \
  "{\"spec\":{\"template\":{\"spec\":{\"hostAliases\":[{\"ip\":\"$KC_IP\",\"hostnames\":[\"keycloak.localtest.me\"]}]}}}}"
kubectl -n $NS set env deploy/slaude-gateway \
  SLAUDE_PANEL=1 SLAUDE_PORTAL=1 \
  SLAUDE_PANEL_OIDC_ISSUER=http://keycloak.localtest.me:8180/realms/slaude-dev \
  SLAUDE_PANEL_OIDC_CLIENT_ID=slaude-panel \
  SLAUDE_PANEL_OIDC_CLIENT_SECRET=dev-secret \
  SLAUDE_PANEL_PUBLIC_URL=$PUBLIC \
  SLAUDE_PANEL_SECRET=local-panel-secret-local-panel-secret! \
  SLAUDE_PANEL_SUPERADMIN=lead@example.com \
  SLAUDE_PANEL_OPERATORS=alice@example.com
kubectl -n $NS rollout status deploy/slaude-gateway --timeout=300s

cat <<MSG

Panel ready. In two terminals:
  kubectl -n $NS port-forward svc/keycloak 8180:8180
  kubectl -n $NS port-forward svc/slaude-gateway 8080:8080
Open $PUBLIC/panel/  — log in lead / dev (superadmin) or alice / dev (operator).
Keycloak admin: http://keycloak.localtest.me:8180  admin / admin
MSG
