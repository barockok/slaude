-- The Slack app a cron job was created under (D1.2). With several registered
-- apps a scheduled run posts as this app, not the oldest registered one. NULL
-- on jobs created before this column existed; those resolve the app from the
-- team when it is unambiguous, else from the only registered app.
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS slack_app_id TEXT;

-- The Slack app a session's thread arrives through, recorded on each inbound
-- event. Turns with no inbound event (the operator panel) carry it into the
-- job token, so their /v1 posts go out as that app. NULL until recorded.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS slack_app_id TEXT;
