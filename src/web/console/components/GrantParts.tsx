import type { ReactNode } from "react";
import type { SubjectKind } from "../../../gateway/panel/api-types";
import { IconBuilding, IconHash, IconUser } from "../../ui";
import { SUBJECT_LABEL } from "../lib/grants";

export { RoleBadge } from "../../shared/RoleBadge";

const KIND_ICON = { user: IconUser, channel: IconHash, workspace: IconBuilding } as const;

/** Kind icon, the Slack id, and an optional second line under the id. */
export function Subject({ kind, id, sub }: { kind: SubjectKind; id: string; sub?: ReactNode }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className="sl-subject">
      <span className="sl-subject__icon" title={SUBJECT_LABEL[kind]}>
        <Icon size={14} title={SUBJECT_LABEL[kind]} />
      </span>
      <span className="sl-stack">
        <span className="sl-mono">{id}</span>
        {sub && <span className="sl-caption sl-truncate">{sub}</span>}
      </span>
    </span>
  );
}
