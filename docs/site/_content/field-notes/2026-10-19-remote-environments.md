# Environments: `/remote` as a choice of saved execution environments

**Date:** 2026-10-19

`/remote` pointed a thread at one hard-coded transport: tailcat SSH to the
initiator's machine, entered as a raw address and directory. It is now one
**kind** of saved, per-person **environment**. `/env` lists, adds, edits,
removes and switches between them; `/remote` stays as an alias. Design:
`docs/superpowers/specs/2026-10-19-remote-environments-design.md`.

## The seam was already there

The six aliased tools only ever call `exec(cmd, opts)` behind a
`RemoteHandle`, and the helper subprocess already typed its transport as a
union. So a kind only has to say how to reach a machine: every kind ends in a
`ConnectInfo` (an ssh2 transport descriptor and a private key). Tools, the
helper, approvals and the local-tool guard are shared. The tailcat-specific
parts were five: the `remote_targets` row, the job-token claim, the session
fingerprint, the command handler's address check and ping, and
`hostVerifier: () => true`.

## Decisions

- **Personal only.** Every environment belongs to one (workspace, user). No
  shared or channel environments.
- **Trust class per kind.** `user-machine` kinds (tailcat, ssh) keep every
  rule `/remote` had: locked `/1on1` owned by the owner, the manager filter,
  the foreign-cron guard, and the lock transitions ending remote mode.
  `provisioned` kinds (sandboxes) run in unlocked threads. A provisioned
  environment that carries secrets is treated as `user-machine`
  (`trustOf`), because once bound to an unlocked thread anyone there could
  steer it.
- **Provisioner deferred.** The interface has `provision` / `teardown`, the
  binding stores an encrypted endpoint and a generation, and the lifecycle
  (provision at bind and at dispatch, teardown at unbind, idle sweep) is
  implemented and tested against a fake kind. No real sandbox kind is
  registered until its provisioner exists.
- **The gateway provisions, never the node.** Nodes stay unprivileged whichever
  provisioner is chosen; they only connect to an endpoint.

## Compatibility

- **Old rows** in `remote_targets` are converted on first read: each address
  becomes a `tailcat` environment of its owner (`tailcat`, `tailcat-2`, …),
  reused across that owner's threads with the same address. The table is
  dropped one release later.
- **Fingerprints.** A tailcat environment hashes exactly as before
  (`[addr, dir]`), so converted threads do not reboot. Every other kind is
  `["env", kind, id, hash, dir]`, where the hash covers the config and
  `updated_at` (and a sandbox's generation), so an edit reboots warm sessions.
- **Old nodes.** The `remote` claim still carries `addr` for tailcat, so a node
  that predates environments keeps working. For any other kind `addr` is `""`.
  An older node passes `""` to the tailcat socket, which refuses it, so it
  fails closed. An absent `addr` would not have: `isTailcatAddr(undefined)`
  coerces to the string `"undefined"`, which matches the address pattern.
- **The gap that remains.** An older node reads a remote claim only for a
  user-scoped turn. A sandbox in an unlocked thread runs as the agent, so an
  older node would run its tools locally. Hence the rule: register a
  provisioned kind only once every node runs this version.

## SSH

- **Host key pinning.** tailcat could skip host verification because its
  address embeds the server's WireGuard key. Plain SSH cannot. The `ssh`
  transport always carries a pin; an empty pin is accepted only by a
  pre-flight that is recording it (trust on first use), which returns the
  presented fingerprint so `/env use` can store it and show it privately. A
  mismatch is `REMOTE_HOST_CHANGED`, detected inside the ssh2 host verifier
  so it is not mistaken for an unreachable host. Editing host, user or port
  drops the pin.
- **Outbound rules.** The ssh host is resolved once on the gateway and checked
  with the outbound policy's address classifier: metadata, link-local and
  reserved always refused; private only with `SLAUDE_ENV_SSH_ALLOW_PRIVATE=1`
  or a host in `SLAUDE_OUTBOUND_INTERNAL_HOSTS`; loopback only with
  `SLAUDE_OUTBOUND_DEV_LOOPBACK=1`. The transport handed to the helper names
  the checked address, so a second DNS answer cannot move it. The check runs
  on the gateway because the helper subprocess gets a minimal environment
  (PATH, HOME) and would not see the operator's settings.

## Split deployments

A node used to fetch only the owner's key (`/remote-key`) and build a tailcat
transport from the claim. It now fetches `GET /v1/tenants/:t/remote-env`. The
gateway serves the transport and key only while the thread is still bound to
the claimed environment, with the claimed hash, and the trust class still
applies (a user-machine environment: the token runs as its owner, under their
lock). A stale token after an edit, an unlock or a re-bind gets 409. The old
endpoint stays for older nodes.

## Not verified

- No real provisioned kind exists, so sandbox latency, idle-TTL tuning and the
  shape of a real provisioner's endpoint are untested.
- `ssh` against real hosts (macOS and Linux sshd), and a TOFU pin across a
  host key rotation, have only been tested against the in-process test server.
- The `/env add` modal's kind switch (`views.update` on a select) has not been
  exercised against a real Slack workspace.
- A mono deployment re-provisions lazily when its helper opens, and reboots a
  warm session after an idle teardown; a split deployment relies on the
  fingerprint changing at the next dispatch. Neither has run on real
  infrastructure.
