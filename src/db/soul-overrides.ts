import { db } from "./schema";

export type OverrideField =
  | "trustedChannels"
  | "allowedChannels"
  | "dmAllowedUsers"
  | "blockedUsers";
export type OverrideAction = "add" | "remove";

export type OverrideRow = {
  field: OverrideField;
  value: string;
  action: OverrideAction;
  created_by: string;
  created_at: number;
};

/** One verdict per (field, value): an upsert overwrites the previous action. */
export function upsert(i: {
  field: OverrideField;
  value: string;
  action: OverrideAction;
  created_by: string;
}): void {
  db.run(
    `INSERT INTO soul_overrides (field, value, action, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(field, value) DO UPDATE SET
       action = excluded.action,
       created_by = excluded.created_by,
       created_at = excluded.created_at`,
    [i.field, i.value, i.action, i.created_by, Date.now()],
  );
}

export function list(): OverrideRow[] {
  return db
    .query(`SELECT * FROM soul_overrides ORDER BY created_at, field, value`)
    .all() as OverrideRow[];
}

export function clear(field?: OverrideField): void {
  if (field) db.run(`DELETE FROM soul_overrides WHERE field = ?`, [field]);
  else db.run(`DELETE FROM soul_overrides`);
}
