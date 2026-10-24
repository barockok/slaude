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
