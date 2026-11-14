/** Dev fixtures for the Users and Boundaries pages (same masking as the server). */
import type { BoundaryListItem, UserDetail, UserListItem } from "../../../gateway/panel/api-types";

const DAY = 86_400_000;

export function domainFixtures(now: number): { users: UserListItem[]; details: Record<string, UserDetail>; boundaries: BoundaryListItem[] } {
  const user = (n: number, over: Partial<UserListItem>): UserListItem => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    kind: "person",
    preferred: null,
    bindings: { declared: 0, observed: 0, verified: 0 },
    aliasCount: 0,
    createdAt: now - n * DAY,
    unmatched: false,
    ...over,
  });
  const users: UserListItem[] = [
    user(1, { preferred: "j***@example.com", bindings: { declared: 0, observed: 0, verified: 2 }, aliasCount: 1 }),
    user(2, { preferred: "slack user U0EXAMPLE", bindings: { declared: 0, observed: 1, verified: 0 } }),
    user(3, { preferred: "slack user U1EXAMPLE", bindings: { declared: 1, observed: 0, verified: 0 } }),
    user(9, { preferred: "p***@example.com", bindings: { declared: 1, observed: 0, verified: 0 }, unmatched: true }),
    user(4, { kind: "bot", preferred: "slack user U2EXAMPLE", bindings: { declared: 0, observed: 1, verified: 0 } }),
  ];
  const details: Record<string, UserDetail> = {
    [users[0]!.id]: {
      id: users[0]!.id, kind: "person", displayName: "Jane Doe", createdAt: users[0]!.createdAt, unmatched: false,
      bindings: [
        { id: "b1", service: "slack", kind: "user", workspace: "T0EXAMPLE", value: "U3EXAMPLE", state: "verified", source: "portal", createdAt: now - DAY, verifiedAt: now - DAY },
        { id: "b2", service: "email", kind: "address", workspace: "", value: "j***@example.com", state: "verified", source: "oidc-login", createdAt: now - DAY, verifiedAt: now - DAY },
      ],
      aliases: [{ oldId: "00000000-0000-4000-8000-0000000000aa", mergedAt: now - 2 * 3_600_000 }],
    },
  };
  for (const u of users.slice(1)) {
    details[u.id] = {
      id: u.id, kind: u.kind, displayName: null, createdAt: u.createdAt, unmatched: u.unmatched,
      bindings: [{
        id: `b-${u.id}`, service: u.preferred?.startsWith("slack") ? "slack" : "email", kind: u.preferred?.startsWith("slack") ? "user" : "address",
        workspace: u.preferred?.startsWith("slack") ? "T0EXAMPLE" : "", value: u.preferred?.replace("slack user ", "") ?? "",
        state: u.bindings.declared ? "declared" : "observed", source: u.bindings.declared ? "sync" : "first-sight", createdAt: u.createdAt, verifiedAt: null,
      }],
      aliases: [],
    };
  }
  const b = (n: number, over: Partial<BoundaryListItem>): BoundaryListItem => ({
    id: `10000000-0000-4000-8000-00000000000${n}`, kind: "channel", service: "slack", workspace: "T0EXAMPLE", value: `C${n}EXAMPLE`,
    state: "observed", displayName: null, createdAt: now - n * DAY, unmatched: false, ...over,
  });
  const boundaries = [
    b(1, { displayName: "team-channel", state: "verified" }),
    b(2, {}),
    b(3, { state: "declared" }),
    b(9, { state: "declared", unmatched: true }),
  ];
  return { users, details, boundaries };
}
