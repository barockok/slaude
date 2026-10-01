# Remote Mode (`/remote`)

`/remote` points a Slack thread at **your own machine**. From the next message on, the agent's shell and file tools (Bash, Read, Write, Edit, Glob, Grep) run there, in a directory you choose. The conversation, the model API key, MCP credentials, the knowledge base and the transcript all stay on slaude. `/remote off` switches back.

> **Prerequisites:** The operator has set `SLAUDE_REMOTE=1` on the deployment (off by default). Your machine runs [tailcat](https://github.com/tailscale/tailcat) and has `perl` (ships with macOS and most Linux).

---

## 1. Set up (once)

1. In the thread, type `/remote key`. slaude replies privately (ephemeral) with a public key and the exact commands. The key is an ed25519 pair slaude generates per workspace and user; the private half never leaves slaude.
2. On your machine, run:
   ```sh
   tailcat genkey --key=default          # once: keeps your address stable
   tailcat serve --key=default --ssh-authorized-keys="ssh-ed25519 AAAA… slaude:<you>" ssh
   ```
3. Copy the address `tailcat serve` prints.

## 2. Commands

| Command | Effect |
|---|---|
| `/remote <address> <directory>` | Switch this thread to your machine. Implies a locked `/1on1` owned by you. |
| `/remote <address>` | New address (for example after restarting tailcat without a stable key), same directory. |
| `/remote` | Status: on or off, directory, direct or relayed path. Never prints the address. |
| `/remote off` | Back to the server. Releases the lock if `/remote` created it. |
| `/remote key` | Show the setup message again. |

## 3. Who can do what while remote is active

Remote implies a locked `/1on1` owned by whoever started it. Only that person drives the thread. A manager or backup is admitted for exactly three things: `/remote off`, `/remote` (status) and `/1on1 off`.

Remote mode also ends when anything changes the lock: `/1on1 off`, opening the 1on1 to guests, a lock change, or an operator unlocking the thread from the panel. The session reloads on the server and background jobs left on your machine are cleaned up best-effort.

## 4. How the tools behave

- **Same approvals as the built-ins.** The approver sees Bash, Write and Edit exactly as on the server. Plan mode denies remote changes; `dontAsk` denies everything but read-only calls; `acceptEdits` allows write and edit but not Bash; with no approver, everything that is not read-only is denied.
- **No fallback to the server.** If your machine is unreachable (laptop asleep, tailcat stopped, new address) tools return `REMOTE_UNREACHABLE` or `REMOTE_AUTH_FAILED` and the agent is told to stop and tell you. Wake the machine or restart `tailcat serve`, then continue.
- **Drops mid-command are reported, not retried.** A connection lost during a command may still have run, so slaude never re-runs it for you.
- **Background jobs** started with Bash can be polled and killed through `bash_output` and `bash_kill`.
- `bash` runs under a login shell; the file tools do not.
- `grep` and `find` are the default search path. Installing `ripgrep` is an optional accelerator and enables multiline search and the `type` filter.

## 5. Security

Commands run as the account that runs `tailcat serve`, with everything that account can reach. **That account is the real security boundary.** Path jailing in the file tools only prevents accidents. For untrusted repositories, run `tailcat serve` under a separate account or inside a container.

Key custody: the private key is encrypted at rest (AES-256-GCM envelope under `SLAUDE_MASTER_KEY`) and is handed only to a turn running as you, authorized by the signed job token (`GET /v1/tenants/:t/remote-key`). It is held in memory by the helper process tree and never placed in argv, environment, disk or logs. The tailcat address travels in the signed job token, so on a split deployment it sits in the queue's job data for the job's lifetime; it is never echoed in replies, status lines or logs. Audit lines record the tool, program name or file basename, exit code and duration only.

## 6. Operator notes

- `SLAUDE_REMOTE=1` enables the feature. `SLAUDE_TAILCAT_BIN` overrides the tailcat binary path (the image installs it at `/usr/local/bin/tailcat`).
- Split deployments: the gateway signs the remote target and a session-config fingerprint into each job token; a node reboots a warm session when the fingerprint changes. Nodes need the tailcat binary.

## 7. Known limitations

- No PDF or notebook (`.ipynb`) reads.
- A background command whose last step is an explicit `exec` loses its job marker, so `/remote off` cannot kill that job.
- A `~` in the directory is resolved once, when you run `/remote`.
- Latency over a relayed (DERP) path has not been measured. On a direct path, connect takes about 0.55 s and a warm command about 20 to 30 ms.
