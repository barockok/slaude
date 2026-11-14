/**
 * Domain-record projection of accounts and slack_identities (slice B, task 3).
 *
 * `accounts` and `slack_identities` stay the authority. The bindings written
 * here are a projection, written inside the same transaction as the
 * authoritative row. Each projection runs under a SAVEPOINT: a failure rolls
 * back only the projection (the login or link still commits) and is logged.
 * The reconciler repairs what a failed projection missed.
 *
 * The account -> user link has no column: the user is found through the
 * account's verified oidc binding (service 'oidc', kind 'subject',
 * workspace = issuer, value = subject).
 *
 * Functions return the events they caused. The caller emits them with
 * `emitDomainEvents` after the transaction commits.
 */
import * as Domain from "./domain";
import type { BindingKey, DomainEvent } from "./domain";
import type { DbClient } from "./schema";
import { parseRef } from "../refs/parse";

const SAVEPOINT = "domain_projection";

/** Run `fn` under a savepoint. On error: roll back to it, log, return `fallback`. */
export async function guardedProjection<T>(tx: DbClient, label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  await tx.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const out = await fn();
    await tx.exec(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return out;
  } catch (e) {
    // If the rollback itself fails the transaction is unusable: let it throw.
    await tx.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await tx.exec(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    console.warn(`[domain] ${label} projection failed, left for the reconciler: ${(e as Error).message}`);
    return fallback;
  }
}

/** The email rule of src/refs, or null when the address cannot normalise. */
export function normaliseEmail(address: string): string | null {
  const r = parseRef(`email:${address}`);
  return r.ok && r.ref.kind === "email" ? r.ref.address : null;
}

const oidcKey = (a: { issuer: string; subject: string }): BindingKey => ({
  service: "oidc",
  kind: "subject",
  workspace: a.issuer,
  value: a.subject,
});

/** The user an account maps to, via its oidc binding; null when none yet. */
export async function userForAccount(a: { issuer: string; subject: string }, tx: DbClient): Promise<string | null> {
  const b = await Domain.findBinding(oidcKey(a), tx);
  return b ? b.user_id : null;
}

/** The account's user, creating the user and a verified oidc binding when absent. */
async function ensureAccountUser(a: { issuer: string; subject: string }, tx: DbClient, events: DomainEvent[]): Promise<string> {
  const r = await Domain.ensureBinding({ ...oidcKey(a), state: "verified", source: "oidc-login" }, tx);
  events.push(...r.events);
  return r.userId;
}

function logConflict(what: string): void {
  console.warn(`[domain] ${what} is held by another verified user, both left untouched (needs the console)`);
}

/**
 * Login: ensure the user and the oidc binding, then the email binding; move the
 * email on change. The email binding is `verified` only when the login proved
 * the address (`emailProven`: email_verified === true on a real email claim).
 * Otherwise it is `observed`: ensured on the account's user when nobody holds
 * it, never moved from another user, and a verified one already held by this
 * user is left as it is (a state never lowers). A value that is not an email
 * address makes no email binding.
 */
export async function projectLogin(
  a: { issuer: string; subject: string; email: string; emailProven?: boolean; previousEmail: string | null },
  tx: DbClient,
): Promise<DomainEvent[]> {
  return guardedProjection(tx, "login", [] as DomainEvent[], async () => {
    const events: DomainEvent[] = [];
    const userId = await ensureAccountUser(a, tx, events);

    const next = normaliseEmail(a.email);
    const prev = a.previousEmail ? normaliseEmail(a.previousEmail) : null;
    if (prev && prev !== next) {
      const old = await Domain.findBinding({ service: "email", kind: "address", workspace: "", value: prev }, tx);
      if (old && old.user_id === userId && old.state === "verified") {
        await tx.run("DELETE FROM bindings WHERE id = ?", [old.id]);
      }
    }
    if (next === null) {
      console.warn("[domain] account email does not normalise, email binding skipped");
      return events;
    }
    if (a.emailProven === true) {
      const r = await Domain.adoptBinding(
        { service: "email", kind: "address", workspace: "", value: next, toUserId: userId, state: "verified" },
        tx,
      );
      if (r.conflict) logConflict("account email");
      events.push(...r.events);
    } else {
      // Another user's binding is left exactly as it is: no move, no state change.
      const key = { service: "email", kind: "address", workspace: "", value: next };
      const held = await Domain.findBinding(key, tx);
      if (!held || held.user_id === userId) {
        const r = await Domain.ensureBinding({ ...key, userId, state: "observed", source: "oidc-login" }, tx);
        events.push(...r.events);
      }
    }
    return events;
  });
}

/** Link: adopt the verified slack binding onto the account's user. */
export async function projectLink(
  a: { issuer: string; subject: string; teamId: string; slackUserId: string },
  tx: DbClient,
): Promise<DomainEvent[]> {
  return guardedProjection(tx, "link", [] as DomainEvent[], async () => {
    const events: DomainEvent[] = [];
    const userId = await ensureAccountUser(a, tx, events);
    const r = await Domain.adoptBinding(
      { service: "slack", kind: "user", workspace: a.teamId, value: a.slackUserId, toUserId: userId, state: "verified" },
      tx,
    );
    if (r.conflict) logConflict("slack identity");
    events.push(...r.events);
    return events;
  });
}

/** Unlink: remove the slack binding when it belongs to the account's user and is verified. */
export async function projectUnlink(
  a: { issuer: string; subject: string; teamId: string; slackUserId: string },
  tx: DbClient,
): Promise<void> {
  await guardedProjection(tx, "unlink", undefined, async () => {
    const userId = await userForAccount(a, tx);
    if (!userId) return;
    const b = await Domain.findBinding({ service: "slack", kind: "user", workspace: a.teamId, value: a.slackUserId }, tx);
    if (b && b.user_id === userId && b.state === "verified") await tx.run("DELETE FROM bindings WHERE id = ?", [b.id]);
  });
}

/**
 * Account deletion: drop the oidc and verified email bindings the account
 * projected, demote its verified slack bindings to observed (the person is
 * still seen in Slack), then drop the user when nothing is left on it and no
 * alias points at it. Call before the account row is deleted, in the same
 * transaction.
 */
export async function projectAccountDeletion(
  a: { issuer: string; subject: string; email: string; slack: { teamId: string; slackUserId: string }[] },
  tx: DbClient,
): Promise<void> {
  await guardedProjection(tx, "account deletion", undefined, async () => {
    const userId = await userForAccount(a, tx);
    if (!userId) return;
    await tx.run("DELETE FROM bindings WHERE service = 'oidc' AND kind = 'subject' AND workspace = ? AND value = ?", [a.issuer, a.subject]);
    const mail = normaliseEmail(a.email);
    if (mail) {
      await tx.run(
        "DELETE FROM bindings WHERE user_id = ? AND service = 'email' AND kind = 'address' AND workspace = '' AND value = ? AND state = 'verified'",
        [userId, mail],
      );
    }
    for (const s of a.slack) {
      await tx.run(
        "UPDATE bindings SET state = 'observed', verified_at = NULL, updated_at = ? WHERE user_id = ? AND service = 'slack' AND kind = 'user' AND workspace = ? AND value = ? AND state = 'verified'",
        [Date.now(), userId, s.teamId, s.slackUserId],
      );
    }
    const left = await tx.one<{ n: number }>("SELECT COUNT(*) AS n FROM bindings WHERE user_id = ?", [userId]);
    const aliased = await tx.one<{ n: number }>("SELECT COUNT(*) AS n FROM user_aliases WHERE user_id = ?", [userId]);
    if (Number(left?.n) === 0 && Number(aliased?.n) === 0) await tx.run("DELETE FROM users WHERE id = ?", [userId]);
  });
}
