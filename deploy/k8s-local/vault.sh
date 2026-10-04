#!/usr/bin/env bash
# Seed and drive the local dev Vault (vault.yaml). up.sh runs `seed`.
#
#   ./vault.sh seed              the read-only policy, the gateway's token, and one
#                                provider secret per local persona (idempotent)
#   ./vault.sh rotate <persona>  write a new version of that persona's credential:
#                                the value is read from stdin when stdin is not a
#                                terminal, else a new placeholder is generated
#   ./vault.sh status            each persona's secret version (never a value)
#
# Secrets live at secret/slaude/personas/<persona> (KV v2), the path the gateway's
# SLAUDE_VAULT_ALLOWED_PREFIXES admits for that persona only. Their fields mirror
# provider.env (api_key, auth_token, oauth_token, base_url), or hold a placeholder
# api_key when it has none: enough for suppressed turns and the verify scripts,
# not for a model call.
#
# `seed` writes a persona's secret only when it is missing or provider.env changed
# since the last seed (a hash in the secret's custom metadata), so a `rotate` is
# kept across up.sh runs until provider.env changes.
#
# Dev mode keeps everything in memory: a restarted vault pod has lost all of it,
# and a re-run of `seed` (or up.sh) puts it back. Values never reach this
# terminal; every vault command runs inside the vault pod, as root, with the root
# token from that pod's own environment, and data goes in on stdin.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib.sh"
PROFILE="${SLAUDE_LOCAL_PROFILE:-slaude-local}"
NS="slaude-scale"
SECRETS="$HERE/secrets.env"
PROVIDER="$HERE/provider.env"
# Every persona the local set and the verify scripts sync.
PERSONAS=(default alpha beta verifier)
POLICY='path "secret/data/slaude/personas/*" { capabilities = ["read"] }'

die() { printf 'vault.sh: %s\n' "$*" >&2; exit 1; }
k() { kubectl --context "$PROFILE" -n "$NS" "$@"; }
# The vault CLI in the vault pod. Arguments are not secret; stdin passes through.
# shellcheck disable=SC2016 # expands in the pod's shell
v() { k exec -i deploy/vault -c vault -- sh -c 'VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN="$VAULT_DEV_ROOT_TOKEN_ID" exec vault "$@"' vault "$@"; }
path_of() { printf 'secret/slaude/personas/%s' "$1"; }
valid_persona() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; }

seed() {
  k rollout status deploy/vault --timeout=300s >/dev/null || die "the vault deployment is not ready"
  printf '%s\n' "$POLICY" | v policy write slaude-personas - >/dev/null || die "could not write the policy"

  # The gateway's token: a periodic orphan token with the read-only policy, its
  # id fixed to SLAUDE_VAULT_TOKEN from the gateway Secret, so the token the
  # gateway holds survives a re-seed. Looked up first; created when missing.
  local tok
  tok="$(sed -n 's/^SLAUDE_VAULT_TOKEN=//p' "$SECRETS" 2>/dev/null | tail -n1)"
  [[ -n "$tok" ]] || die "no SLAUDE_VAULT_TOKEN in $SECRETS; run up.sh"
  if printf '{"token":"%s"}' "$tok" | v write -format=json auth/token/lookup - >/dev/null 2>&1; then
    echo "vault: gateway token present"
  else
    printf '{"id":"%s","policies":["slaude-personas"],"period":"768h","display_name":"slaude-gateway","no_default_policy":false}' "$tok" \
      | v write auth/token/create-orphan - >/dev/null || die "could not create the gateway token"
    echo "vault: gateway token created (policy slaude-personas)"
  fi

  local p want have
  for p in "${PERSONAS[@]}"; do
    want="$(vault_secret_json "$PROVIDER" "$p" | shasum -a 256 | cut -c1-16)"
    have="$(v kv metadata get -format=json "$(path_of "$p")" 2>/dev/null \
      | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print((d.get("custom_metadata") or {}).get("seed",""))' 2>/dev/null || true)"
    if [[ "$have" == "$want" ]]; then
      echo "vault: $(path_of "$p") up to date"
      continue
    fi
    vault_secret_json "$PROVIDER" "$p" | v kv put "$(path_of "$p")" - >/dev/null || die "could not write $(path_of "$p")"
    v kv metadata put -custom-metadata="seed=$want" "$(path_of "$p")" >/dev/null || die "could not tag $(path_of "$p")"
    echo "vault: $(path_of "$p") written"
  done
}

version_of() { # <persona>
  v kv metadata get -format=json "$(path_of "$1")" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["current_version"])'
}

rotate() { # <persona>
  local p="$1" field value data ver
  valid_persona "$p" || die "'$p' is not a persona name"
  # The credential field the secret carries (the same choice the persona's refs make).
  field="$(vault_secret_json "$PROVIDER" "$p" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(f for f in ("api_key","auth_token","oauth_token") if f in d))')"
  if [[ -t 0 ]]; then
    value="local-rotated-$(date +%s)-$RANDOM"
  else
    IFS= read -r value || true
    [[ -n "$value" ]] || die "no value on stdin"
  fi
  data="$(python3 -c 'import json,sys; print(json.dumps({sys.argv[1]: sys.argv[2]}))' "$field" "$value")"
  printf '%s' "$data" | v kv patch "$(path_of "$p")" - >/dev/null || die "could not patch $(path_of "$p")"
  ver="$(version_of "$p")"
  # The hash prefix lets verify-turns.sh compare it with a bundle; never the value.
  printf 'rotated %s field=%s version=%s sha=%s\n' "$p" "$field" "$ver" "$(printf '%s' "$value" | shasum -a 256 | cut -c1-12)"
}

status() {
  local p ver
  for p in "${PERSONAS[@]}"; do
    ver="$(version_of "$p" || true)"
    printf '%s: %s\n' "$(path_of "$p")" "${ver:+version $ver}${ver:-missing}"
  done
}

case "${1:-}" in
  seed) seed ;;
  rotate) [[ -n "${2:-}" ]] || die "usage: vault.sh rotate <persona>"; rotate "$2" ;;
  status) status ;;
  *) die "usage: vault.sh seed | rotate <persona> | status" ;;
esac
