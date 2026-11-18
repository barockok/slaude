# Remote storage on a single box with a non-root worker (rc.35)

rc.34 shipped `SLAUDE_STORAGE=s3` for clusters whose pods each own a writable `$SLAUDE_HOME`. A compose deployment
where the gateway and a non-root worker share one root-owned data directory (the sumopod box) breaks it in four places.
This release closes them. Every change is inert unless `SLAUDE_STORAGE=s3`.

1. **State directory.** The node keeps sync markers in `$SLAUDE_HOME/.sync-state`, which a non-root worker cannot
   create. `SLAUDE_SYNC_STATE_DIR` moves them (and the skills sync state) to a path the operator provides.
2. **Skills mirror.** It writes the skills directory and its state file. Where gateway and worker already share that
   directory it is redundant and, for a read-only worker, an error on every change. `SLAUDE_SKILLS_MIRROR=0` turned it
   off in both roles. (Superseded in rc.36: the switch is removed and the mirror follows the storage mode.)
3. **Root-owned working directories.** The gateway creates each session's directory in `ensureSession`; on a shared
   volume it is root-owned and the worker cannot write into it. In S3 mode the gateway no longer creates it: the node
   creates it when it hydrates. Attachments follow: the gateway downloads them to a private temp directory, stages them
   in the bucket's inbox, and tells the agent the real working-directory path the node will place them at.
4. **Eviction must not throw.** Removing a local copy that holds files the node cannot delete (left by an earlier root
   process) is logged, never raised into the turn.

Tasks (TDD, one commit each): config helpers; state dir wiring (fs-sync, skills sync); skills mirror switch (node and
gateway); eviction hardening; gateway no-mkdir; attachment staging helper and its call site; docs and release notes;
bump to rc.35; PR, review, CI, merge, tag, deploy through vps-hardening, enable on the box, smoke test.
