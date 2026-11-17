# Environments (`/env`)

An **environment** is a saved place where a thread's shell and file tools (Bash, Read, Write, Edit, Glob, Grep) can run. You save environments once and then pick one per thread, the way a desktop coding agent lets you choose where a session runs. `/remote` from the [Remote mode guide](remote.md) is the first kind of environment (tailcat), and still works as a shortcut.

Only the tools move. The conversation, the model API key, MCP credentials, the knowledge base and the transcript stay on slaude.

> **Prerequisites:** The operator has set `SLAUDE_REMOTE=1` (off by default). The machine you connect to has `perl` and `bash`.

---

## 1. Kinds

| Kind | Where tools run | Trust class |
|---|---|---|
| `tailcat` | Your own machine, over [tailcat](https://github.com/tailscale/tailcat) SSH. No open port needed. | personal |
| `ssh` | A host you control, over plain SSH. The host key is pinned. | personal |
| Sandbox kinds (Docker-in-Docker, Firecracker, …) | A disposable sandbox slaude starts for the thread | sandbox |

Sandbox kinds appear in the kind list once the operator's deployment provides a sandbox provisioner. Until then, only `tailcat` and `ssh` are listed.

### Trust classes

- **Personal** environments reach a person's own machine. Using one locks the thread to you as a `/1on1`. Only you drive it; a manager is heard only for `/env off`, `/env` (status) and `/1on1 off`. Choosing one is refused while someone else's cron job fires in the thread. Anything that changes the lock (`/1on1 off`, opening the 1on1, a lock change) switches the thread back to the server.
- **Sandbox** environments are disposable and carry none of your secrets, so they work in ordinary shared threads with no lock. Anyone the thread admits can use the sandbox and switch it off. A lock change leaves the sandbox in place. A sandbox that has been idle for an hour is stopped, and it starts again on the thread's next message. If a sandbox environment is ever given a secret, it is treated as personal instead.

## 2. Commands

| Command | Effect |
|---|---|
| `/env` | This thread's environment and its health, plus a private list of your environments with **Use** buttons and **Add environment**. Never prints an address. |
| `/env add` | Private form: pick a kind, then fill in its fields, a name and (optionally) a directory. With a directory, the thread switches to the new environment at once. |
| `/env add <kind> <name> key=value… [dir=<directory>]` | The same without the form. Values typed here are visible in the thread. |
| `/env use <name> [directory]` | Run this thread's tools in that environment. Without a directory: the thread's last one, else the environment's default. |
| `/env edit <name> key=value… [name=<new>] [dir=<default>]` | Change an environment. Threads using it switch on their next message. |
| `/env rm <name>` | Delete it. Every thread using it goes back to the server. |
| `/env off` | Back to the server. Releases the lock if choosing the environment created it. |
| `/env list` | Your environments, privately. |
| `/env key [kind]` | Your slaude public key and that kind's setup steps, privately. |

Names are up to 32 lowercase letters, digits, `.`, `_` or `-`. Environments are personal: only you can see, use, edit or delete yours.

## 3. Setting up each kind

**tailcat.** `/env key tailcat` shows the steps: install tailcat, `tailcat genkey --key=default`, then `tailcat serve --key=default --ssh-authorized-keys="<your key>" ssh`. Add the environment with the address it prints (field `addr`). See the [Remote mode guide](remote.md) for details.

**ssh.** `/env key ssh` shows your public key; add it to the account's `~/.ssh/authorized_keys` on the host. Fields: `host`, `user`, optional `port` (22) and optional `hostKey`, the host's `SHA256:…` fingerprint (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Without `hostKey`, the key the host presents the first time you use the environment is pinned and shown to you privately. If it ever changes, connecting stops with `REMOTE_HOST_CHANGED`. Changing `host`, `user` or `port` drops the pin; the next `/env use` pins the new host's key.

The ssh host is checked against the deployment's outbound rules: cloud metadata, link-local and reserved addresses are always refused; private (LAN) addresses only when the operator allows them; loopback only in development. The connection goes to the address that was checked.

## 4. Errors the agent stops on

| Code | Meaning |
|---|---|
| `REMOTE_UNREACHABLE` | The machine or sandbox does not answer (asleep, stopped, new address). |
| `REMOTE_AUTH_FAILED` | It rejected slaude's key. Run `/env key` and install the key again. |
| `REMOTE_HOST_CHANGED` | An ssh host presented a different host key than the pinned one. |
| `REMOTE_PROVISION_FAILED` | The thread's sandbox could not be started. |

There is never a fallback to the server: the agent stops and tells you.

## 5. Operator notes

- `SLAUDE_REMOTE=1` enables `/env` and `/remote`. The form needs Slack interactivity (already required for approvals).
- `SLAUDE_ENV_SSH_ALLOW_PRIVATE=1` lets ssh environments reach private address ranges (a LAN host). Hosts named in `SLAUDE_OUTBOUND_INTERNAL_HOSTS` may reach private ranges without it. `SLAUDE_OUTBOUND_DEV_LOOPBACK=1` admits loopback, for development.
- Split deployments: the job token names the thread's environment by id and a config hash (no addresses, except a tailcat address for nodes that predate environments). A node fetches how to connect from the gateway (`GET /v1/tenants/:t/remote-env`), which re-checks that the thread is still bound to that environment, with the same hash, and that the trust class still applies. Editing an environment changes the hash, so warm sessions reboot onto the new config.
- Existing `/remote` threads are converted on first use: each tailcat address becomes a `tailcat` environment of its owner (`tailcat`, `tailcat-2`, …), and the session fingerprint stays the same, so warm sessions do not reboot.
- A sandbox kind is registered only once its provisioner exists, and only after every node runs a version that knows environments: an older node reads only the pre-environment claim and would run an unlocked sandbox thread's tools on the node itself.
- Voice calls stay agent-only: a thread in any environment refuses a call, as a `/remote` thread did.

## 6. Shared environments (rc.24)

A shared environment is one ssh machine many people drive through an agent. It
is declared once in the deploy repository, not added from Slack, and it has no
owner.

**Definition file**, `environments/<name>.yaml` (the name is the file name,
`^[a-z0-9][a-z0-9-]{0,40}$`, and the reference `env:<name>`):

```yaml
# yaml-language-server: $schema=https://barockok.github.io/slaude/schemas/environment.schema.json
name: team-sandbox
description: Shared build box for the platform team.
kind: ssh
shared: true            # required, literal true
trust: unlocked         # required, literal "unlocked"
defaultDir: /srv/work   # absolute path or ~/...
ssh:
  host: build-box.example.com
  user: dev
  port: 22              # optional
  hostKey: "SHA256:<43 characters>"   # required: no trust on first use
  allowPrivateAddress: false          # optional
```

Every level is strict: an unknown key is refused (the message names the key,
never the value). There is no key for a private key, password or token, and a
value shaped like one is refused: slaude generates the key pair at first sync and
only the public key is ever shown (the console's Environments page, for a
superadmin). Install it in the account's `~/.ssh/authorized_keys`. `kind:
tailcat` and `kind: provisioned` are refused ("not supported for shared
environments yet"). A host that is an address literal is checked at sync:
loopback, private, link-local, metadata and reserved addresses are refused unless
`allowPrivateAddress: true`, and even then the gateway's own rules at connect
(`SLAUDE_ENV_SSH_ALLOW_PRIVATE`) still apply. A host name is resolved only when
connecting.

**Allowing it on an agent**, in `personas/<name>/agent.yaml`:

```yaml
environment:
  allow: [env:team-sandbox]     # required, 1 to 16, no repeats
  default: env:team-sandbox     # optional; stored, not applied in rc.24
```

An agent with no `environment:` key can use no shared environment. Only `env:`
references go here; writing `kind`, `host` or any configuration under it is
refused.

**Using it.** In a thread, `/env use env:team-sandbox` binds the thread. The
reply says plainly that the machine is shared: anyone in the thread can steer it
through the agent, and what runs there is visible to the team. The thread needs
no `/1on1` lock and nothing locks it. Normal approvals still apply. `/env list`
shows the shared environments the current agent may use; `/env off` returns to
the server (anyone the thread admits may do it).

**What is checked, every turn.** The binding is per thread, so the answer is
asked per agent whenever a turn gets a target or a node asks for the key: the
agent's own `environment.allow` must name it, the definition must be live and
belong to the agent's tenant, and the turn must be interactive. A second agent
answering in a thread another agent bound is refused (one notice per thread per
hour, nothing runs, nothing runs on the server instead). Scheduled, wake and
background turns never run on a shared environment. Removing the file retires the
definition: bound threads are refused until `/env off`.

**Operator notes.**
- Needs `SLAUDE_REMOTE=1` on the gateway; sync refuses an agent that declares
  `environment:` otherwise. Database tenants only (`SLAUDE_DB=pg`).
- Nodes must advertise `shared-env/1` for an agent that declares `environment:`.
  The key reaches every node that opens a handle, and there is no rotation yet:
  to replace it, unbind the threads and define the machine under a new name.
- Validate on pull requests with `bun run personas render ./ --check`: it parses
  every file under `environments/` and resolves each agent reference offline.
- Rolling back to rc.23: `slaude env unbind-shared --tenant <id> --dry-run`, then
  `--apply`, then redeploy. Without it, rc.23 runs a thread still bound to a shared
  machine on the server (see the [rollback runbook](../deploy/rollback.md)).
- Retiring a definition or removing an agent's allow entry does not rotate the
  machine's key: the key pair stays stored, and a copy may be held by nodes that
  already opened a handle. Handles to a shared machine ask the gateway again every
  couple of minutes and stop at the next command once the agent no longer allows it,
  but the key itself is only replaced by a later release (rotation is a follow-up).
  To retire a machine for good, remove the key from its `authorized_keys`.
- If `SLAUDE_REMOTE` is turned off while threads are still bound to a shared machine,
  those threads are refused (`/env` is off too): run `slaude env unbind-shared`.

## 7. Trying the full scenario on a staging mono

Locally or on a staging single-process gateway with `SLAUDE_REMOTE=1` (for a
split deployment, a gateway plus a node with `SLAUDE_ROLE=node`; `bun run sim`
from `src/gateway/sim/cli.ts` gives a mono gateway, and the in-process ssh test
server of `tests/remote/environments.test.ts` stands in for the machine):

1. Add `environments/team-sandbox.yaml` (placeholder host and `hostKey`) and give
   `agent-a` `environment: { allow: [env:team-sandbox] }`. `slaude personas render
   <repo> --check` passes; each bad input (tailcat, no `shared`, a private IP,
   a token-shaped value, an inline `host:` under `environment:`) fails with the
   stated message and no value.
2. Dry run, apply, resync (unchanged). Install the public key from the console.
3. In an `agent-a` thread: `/env use env:team-sandbox` prints the shared-machine
   warning; ask for `hostname`; the answer is the machine's; the thread is not
   locked; the approval card appears.
4. In an `agent-b` thread (no key), and in `agent-b` replying inside the thread
   `agent-a` bound: no key reaches the node, the turn is refused with the notice,
   nothing runs on the server. A cron job and a wake turn of `agent-a` in the
   bound thread are refused.
5. Retire the file and resync: the bound thread's next turn is refused (mono and
   split), and `/env list` no longer offers it.
6. A personal `/env use <mine>` still locks the thread and works.
7. Grep gateway and node logs for the host and the key: zero hits.
