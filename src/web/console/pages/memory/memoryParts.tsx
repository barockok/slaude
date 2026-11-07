import type { MemoryStoreKind } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Link } from "../../../lib/router";
import { Badge, Card, EmptyState, IconLock, type BadgeTone } from "../../../ui";
import { ErrorState } from "../../components/ErrorState";

export const KIND_LABEL: Record<MemoryStoreKind, string> = {
  agent: "Agent mind",
  shared: "Shared",
  public: "Public",
  personal: "Personal",
  profile: "Profile",
  library: "Library",
  other: "Other",
};

const KIND_TONE: Record<MemoryStoreKind, BadgeTone> = {
  agent: "accent",
  shared: "neutral",
  public: "success",
  personal: "warning",
  profile: "warning",
  library: "neutral",
  other: "neutral",
};

export function KindBadge({ kind }: { kind: MemoryStoreKind }) {
  return <Badge tone={KIND_TONE[kind] ?? "neutral"}>{KIND_LABEL[kind] ?? kind}</Badge>;
}

/** Personal and profile stores: one person's memory, superadmin only. */
export const isPrivateKind = (kind: MemoryStoreKind) => kind === "personal" || kind === "profile";
export const isPrivateStoreId = (id: string) => /^(user-|profile-)/.test(id);

export function PrivateBadge() {
  return (
    <span className="sl-private" title="Only superadmins can open this store, and every page they open is recorded in the audit trail.">
      <IconLock size={12} />
      Private, views are audited
    </span>
  );
}

export const storePath = (id: string) => `/memory/${encodeURIComponent(id)}`;
export const pagePath = (store: string, slug: string) => `/memory/${encodeURIComponent(store)}/page?slug=${encodeURIComponent(slug)}`;

/** A failed load; a 403 on a private store explains itself instead of offering a retry. */
export function MemoryError({ what, error, onRetry }: { what: string; error: Error; onRetry: () => void }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Card>
        <EmptyState
          icon={<IconLock size={20} />}
          title="This store is private"
          description="Personal and profile stores hold what one person told an agent. Only superadmins can open them, and each page they open is recorded in the audit trail."
          action={
            <Link className="sl-link" to="/memory">
              Back to memory stores
            </Link>
          }
        />
      </Card>
    );
  }
  return (
    <Card>
      <ErrorState what={what} error={error} onRetry={onRetry} />
    </Card>
  );
}
