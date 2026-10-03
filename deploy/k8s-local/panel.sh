#!/usr/bin/env bash
# Enable the panel + portal on the local cluster, with an in-cluster Keycloak as
# the OIDC provider. Run after up.sh. up.sh re-applies the stock overlay, so
# re-run this after any up.sh.
#
# The issuer is http://keycloak.localtest.me:8180. That public wildcard name
# resolves to 127.0.0.1 on your Mac (no /etc/hosts edit), and the gateway pods
# get a hostAlias pointing it at the Keycloak Service. Then port-forward
# svc/keycloak 8180 and svc/slaude-gateway 8080 (printed below).
#
# SLAUDE_LOCAL_PUBLIC_URL sets where the panel and portal are reached
# (default http://localhost:8080). Set it to a tunnel hostname such as
# https://slaude.example.com to serve them there; the Keycloak client then
# registers both that URL and the localhost one as redirect URIs.
set -euo pipefail
NS=slaude-scale
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REALM="$HERE/../../dev/keycloak/slaude-dev-realm.json"
PUBLIC="${SLAUDE_LOCAL_PUBLIC_URL:-http://localhost:8080}"
PUBLIC="${PUBLIC%/}"

# The dev realm registers only the localhost panel callback. Register the panel
# and portal callbacks for both localhost and the configured public URL.
python3 - "$REALM" "$PUBLIC" <<'PY' | kubectl -n $NS create configmap keycloak-realm --from-file=slaude-dev-realm.json=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
import json, sys
r = json.load(open(sys.argv[1]))
bases = ["http://localhost:8080"]
if sys.argv[2] not in bases:
    bases.append(sys.argv[2])
for c in r["clients"]:
    if c["clientId"] == "slaude-panel":
        c["redirectUris"] = [f"{b}/{p}/auth/callback" for b in bases for p in ("panel", "portal")]
        c["webOrigins"] = bases
print(json.dumps(r))
PY
kubectl apply -f "$HERE/keycloak.yaml"
# Keycloak only imports the realm when it starts on an empty database (dev mode
# keeps it in the container), so a restart is what picks up a changed realm.
kubectl -n $NS rollout restart deploy/keycloak
kubectl -n $NS rollout status deploy/keycloak --timeout=600s

# Add (or repoint) one hostAlias without disturbing the others: a merge patch
# would replace the whole list.
ensure_alias() { # <hostname> <ip>
  kubectl -n $NS get deploy slaude-gateway -o json | python3 -c '
import json, sys
host, ip = sys.argv[1], sys.argv[2]
d = json.load(sys.stdin)
al = [a for a in d["spec"]["template"]["spec"].get("hostAliases", []) if host not in a["hostnames"]]
al.append({"ip": ip, "hostnames": [host]})
print(json.dumps({"spec": {"template": {"spec": {"hostAliases": al}}}}))' "$1" "$2" |
    kubectl -n $NS patch deploy/slaude-gateway --type merge --patch-file /dev/stdin
}
ensure_alias keycloak.localtest.me "$(kubectl -n $NS get svc keycloak -o jsonpath='{.spec.clusterIP}')"
kubectl -n $NS set env deploy/slaude-gateway \
  SLAUDE_PANEL=1 SLAUDE_PORTAL=1 \
  SLAUDE_PANEL_OIDC_ISSUER=http://keycloak.localtest.me:8180/realms/slaude-dev \
  SLAUDE_PANEL_OIDC_CLIENT_ID=slaude-panel \
  SLAUDE_PANEL_OIDC_CLIENT_SECRET=dev-secret \
  SLAUDE_PANEL_PUBLIC_URL="$PUBLIC" \
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
