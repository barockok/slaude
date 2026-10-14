# Two flaky tests: a job read in two halves, and a sim that waited one tick

Two tests failed intermittently on the real Postgres CI jobs and passed on a
re-run. Neither was a test-only problem in the same way: the first was a product
race that the test happened to catch, the second was the simulator assuming a
database write fits in one event-loop tick.

## Relabel: a failed job read as a snapshot from before it failed

`relabel end to end (real Redis)` timed out waiting for the in-flight turn to be
re-dispatched to the persona's new label. The log showed the old node fail the
job with `LABEL_MISMATCH`, then the gateway's event follower report
`events-stream gap ... state=failed` and synthesize a generic `TURN_FAILED`. The
re-dispatch never ran, so the message never reached the new node.

The follower checks each job it waits on with two reads: `getJob(id)` (a
snapshot of the job hash) and then `job.getState()`. BullMQ records the failed
state and the failure reason together, but the follower's two reads are not
atomic with each other. When the node fails the job between them, the follower
holds a snapshot with no `failedReason` next to a fresh `failed` state. The
`LABEL_MISMATCH` branch never matches, and the turn ends as a plain failure.

In production that is the user seeing a failure message, and the message being
dropped, instead of the turn running once more on the right node.

Fix: once the follower sees a settled state it reads the job again, and takes
the reason and the job data from that read. A read taken after the settled
state was observed carries the reason. The unit test settles the job inside the
follower's first `getState`, which reproduces the race deterministically.

## approval-authz: the card is posted after a database write

The `approval-authz` sim scenario failed with `expect_card {"kind":"approval"}
- no match`: only the `:eyes:` reaction was on the bus. The stub agent runs its
behavior detached, and the sim engine waited one `setTimeout(0)` for the card.
The approval gate posts the card only after `PendingGates.create(...)`. On
SQLite that write completes within the tick; on real Postgres it is a network
round trip, which sometimes takes longer. An earlier REPL test had already
worked around the same thing with an explicit wait.

Fix: after a send or a click, the engine waits until the stub's turn finishes
or a new live gate card appears, bounded at 10 s. A send that starts no turn (a
slash command, a dropped message) does not wait. A click that decides a gate
waits for the resumed turn, because the reply after the decision is also posted
after a database write.

## Also on this list

`warm-then-cold across two nodes` (fixed in rc.7) was the same family: the test
read the shared queue's completed count right after the reply arrived, but the
reply is posted from inside the job, before BullMQ marks it completed.
