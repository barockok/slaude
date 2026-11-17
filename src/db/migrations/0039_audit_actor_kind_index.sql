-- The domain reconciler lists the distinct Slack actors of the audit log
-- (WHERE actor_kind = 'slack_user'); the existing (actor_id, id) index cannot
-- serve that filter, so every boot scanned the table. This one lets the
-- DISTINCT walk an index. DDL only, safe to rerun.
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_kind ON audit_events (actor_kind, actor_id);
