# Domain objects and typed references

Status: proposed. The decisions below were taken with the owner and checked by an
independent design review. Slice A (the grammar) is implemented first; the
other slices are listed at the end and each gets its own plan.

## Goal

- An agent is defined in one managed, declarative definition. Nothing that
  represents the agent lives outside it: no structure in prose, no scattered
  rows or config. The definition also says where the agent runs.
- Every domain object has one explicit definition. Objects with a fixed shape
  (Agent, Session, Environment, User, Boundary) have exactly one.
- User and Boundary are our own objects. Slack is an adapter over them. A user
  can bind a Slack user, an email address, a WhatsApp phone number or a
  Telegram id; a Slack channel or a WhatsApp group maps to a boundary.
- A reference to a user or a boundary in any schema or definition says what kind
  of reference it is. A bare id is never the long-term form.

## Domain objects

| Object | Shape | Definition or record |
|---|---|---|
| Agent | fixed | declarative (`agent.yaml`) |
| Environment | fixed envelope, `kind` varies (ssh, tailcat, provisioned) | per-person ones are runtime records; shared ones become definition files (later slice) |
| Node | fixed | runtime (credential and labels); not declared in a repo |
| Session | fixed | runtime |
| User | fixed, joined to services through bindings | runtime records, also created from definitions |
| Binding | varies by service (`slack`, `email`, `oidc`, later `whatsapp`, `telegram`) | runtime, or declared by a definition |
| Boundary | fixed, joined to a service through a binding (`slack:channel`, later `whatsapp:group`) | runtime records, also created from definitions |
| Trust class | fixed enum (`public`, `trusted`, `dm`) | declarative, per agent |
| Mandate, Grant, Skill, Guardrail, MCP server | fixed | already declarative; not re-wrapped |
| MCP credential, memory slice, cron job, commitment, wake state, audit event, 1on1 lock, env binding | fixed | runtime |

A thread is not a boundary. It is an opaque conversation locator inside one.
A session's identity becomes (agent, boundary, locator).

## References

### Grammar

A reference is `scheme:rest`. Each scheme owns the shape of its rest.

- Internal: `<kind>:<id>` where kind is `user`, `boundary`, `agent`, `env` or
  `node`. The id is the hidden internal id. Operators rarely write these; they
  appear in audit, the console and sync reports.
- External: `<service>:<kind>:<id>`, for example `slack:user:U0EXAMPLE`,
  `slack:channel:C0EXAMPLE`, `whatsapp:phone:+620000000000`,
  `telegram:user:12345`.
- Email: `email:<address>`. A two-part reference by exception, because email is
  not owned by a service.
- Selectors, not references: `trust:public`, `trust:trusted`, `dm`. They select
  boundaries by class.

### Workspace qualification

Slack ids are per workspace. The stored canonical form always carries the
workspace: `slack:user:T0EXAMPLE/U0EXAMPLE`, `slack:channel:T0EXAMPLE/C0EXAMPLE`.
While exactly one workspace is connected, the short form
(`slack:user:U0EXAMPLE`) is accepted and resolved against it. The moment a second
workspace is connected the short form is refused as ambiguous, so adding a
workspace can never silently re-point an existing reference.

### Normalisation

Applied at parse time, before any lookup.

- Scheme and kind are lowercase and Slack ids (and workspace ids) uppercase, as Slack issues them. A reference written in another case is refused, not folded.
- Email: trim, lowercase the whole address. The local part must be ASCII: compatibility characters (fullwidth letters, the Kelvin sign) are refused, not folded. The domain is folded (NFKC, then IDNA). Plus-addressing and dots are
  kept: `a+x@` and `a@` are different bindings, and joining them is a human act.
  Display names, angle brackets and whitespace are refused.
- Phone: E.164 only, with the leading `+`.
- A `:` inside the last segment needs no escaping, because each scheme fixes the
  number of leading segments. No percent-encoding. No empty segment.
- Length cap 256 (an email reference may carry its full 254-character address after `email:`).

### Resolution

`resolve(ref)` returns the record, its kind and the binding that matched. An
external reference resolves through a unique binding. Two references to the same
record are equal, and access code compares internal ids, never strings.

### Transition

- A bare Slack id (`U0...`, `C0...`) in `agent.yaml` is accepted for one release,
  read as the matching Slack reference, with a warning that names the file and
  field in `personas render` output (which CI runs). The release after refuses it.
- `mandate.scoped[].boundary` of the form `channel:<id>` is the bare Slack
  shortcut. It becomes `slack:channel:<id>`, with the old form accepted and
  warned for one release. `trust:*` and `dm` are unchanged.

## Users and bindings

- The user key is a hidden generated id that never changes and never appears in
  definitions. Email is a verified binding, and the one people usually write.
  Reasons: emails change and are reused, not everyone has one, and an address is
  personal data that would otherwise sit in every audit row.
- Consoles and reports show the preferred binding (the verified email, else the
  Slack handle), never the raw id.
- A binding has a state: `declared` (named in a definition), `observed` (seen
  acting on a service; the gateway verified the service's signature) or
  `verified` (proven: an OIDC login for email, the delivered portal link for
  Slack, a future code for a phone).
- A declared binding grants nothing. An ACL that names `email:x` takes effect only
  once a verified binding joins that email to the acting user.

### Merging

Owner decision: records merge automatically on proof, with no console step in the
normal path. A Slack profile email counts as proof only in a workspace the owner
opts in, and then only for ordinary access.

1. **Proof path, always on.** A portal login proves control of the identity
   provider account and its verified email. The delivered portal link proves
   control of the Slack account. When both are proven for one person, the record
   holding the Slack binding and the record holding that email become one, at
   once and in full, including manager and approver grants.
2. **Workspace trust, opt in, off by default.** A workspace definition may set
   `trustProfileEmail: true`. Then a Slack user who is a full member of that
   workspace (not a guest, not a user from another workspace such as a Slack
   Connect external) and whose Slack profile email is confirmed merges into the
   record holding that email, without the portal step. This activates ordinary
   access only. Manager and approver grants stay inactive until the proof path
   completes. Reason: a workspace admin, or an external organisation in a shared
   channel, controls what a profile shows, so a profile email is weaker proof than
   a login. The owner accepts that trust for a workspace they administer.
3. **Never automatic.**
   - Conflicts: the same email with a different verified Slack account in the same
     workspace, or two different verified emails on one side. The console shows a
     "same person?" proposal.
   - Aliases: `a+x@` and `a@` stay distinct bindings; joining them is a human act.
   - Records that represent an agent or a bot.
   - Any merge that would rest on two declared bindings.
4. **Survivor.** The record that holds the verified email, otherwise the older
   one. Bindings, grants, credentials and memory slices move to it. Old ids keep
   resolving through an alias table, and audit rows are never rewritten.
5. **Transparency and undo.** Every automatic merge writes a `user.merged` audit
   event that lists what moved, including any grants that became active because
   of the merge, and sends the person a short message in Slack saying what was
   linked. A merge can be undone from the console for a limited time, using the
   moved-items list in the audit event.
6. **The console is for exceptions only:** conflict proposals, aliases and undo.

## Creation on reference

Records are created the first time they are referenced.

- Definition sync resolves every reference inside the apply transaction and
  creates what is missing in state `declared`. The sync report lists what it
  created next to the warnings.
- An observed record is created wherever a session or audit row is written,
  including for an actor that was refused, and at a pre-admission point in the
  gateway so a message refused at a gate is recorded too. It grants nothing.
  Without this, sessions and audit could not be keyed by internal ids.
- A binding is unique per (service, kind, workspace, value). Creation is insert-or-ignore
  then re-read, so two gateway replicas cannot create duplicates.
- A typo creates an empty, unmatched record. Sync lists every created record, and
  a strict mode refuses a reference that would create one. The console flags
  records with only declared bindings as unmatched after a while.
- Sync never deletes a record. Deletion is an explicit console action. Creation,
  linking, merging and deletion each write an audit event.
- Boundaries follow the same path. A boundary has one external binding today, so
  merging boundaries is not needed until two services share a room.

## Node and environment binding

- `runsOn` stays one node label, as it is. A label can match several nodes, so it
  is a pool. Nodes are credentials; the repository does not declare machines.
- Environments stay as they are for now. When shared environments are added they
  become their own definition files, and the agent refers to them with an
  `environment:` key shaped as a default plus an allowed list, for example
  `environment: { default: env:team-sandbox, allow: [env:team-sandbox] }`.
  Embedding an environment's configuration inline in `agent.yaml` is refused.

## Slices

- **A, grammar (this slice).** A parser and normaliser for references. The
  `agent.yaml` schema accepts typed references wherever it takes a user id or a
  channel id today, with bare ids accepted and warned. Compilation still produces
  today's data by reading `slack:` references down to the Slack id. Other schemes
  parse and validate, then are refused at compile with a clear message until
  slice B resolves them. The JSON Schema is regenerated. This unblocks migrating
  `sam` and the default persona once, to the new grammar.
- **B, records. Implemented** (v0.46.0-rc.18). `users`, `bindings`,
  `boundaries`, `user_aliases` (no `merged_into`; the alias table is the only
  merge record). Backfill from accounts, Slack identities and the Slack ids
  already in sessions, grants and audit. Sync creates declared records and
  reports them, with a strict mode. What differs from the plan above:
  - Backfill is a reconciler (`slaude domain reconcile`, also run at gateway
    boot), not a migration step, so rolling deploys and sqlite are covered.
  - The merge on proof is the adopt rule only, and only for an unverified
    (observed or declared) record. Two verified records are a reported
    conflict, left for slice C.
  - Observed records follow session and audit writes (see Creation on
    reference), not every event.
  - The console shows Users and Boundaries read only; conflict and undo UI
    wait for slice C.
- **C, access on internal ids.** Grants and admission resolve the acting user
  first. `email:` in an ACL starts to work through the portal link, and the
  optional workspace `trustProfileEmail` setting arrives here.
- **D, sessions and thread-scoped tables** gain a boundary column read through a
  resolver, and the unique indexes move after one release.
- **E, environments as definitions** and the `environment:` key.
- **F, memory slices and MCP credentials** fold into users. Last, because it
  touches the brain.

Bare-id acceptance is removed in the release after slice A reaches a stable
release.

## Not decided here

- Whether memory slices are renamed on merge or kept behind an alias table.
  Alias table first; revisit in slice F.
- Slack Enterprise Grid, where user ids span workspaces. The workspace qualifier
  is written so this can be added without changing existing references.
