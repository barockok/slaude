-- The Slack app a proposal's card was posted as (Task 9 fix round 1), stamped
-- when the card is first posted: a click must come from that same app and
-- workspace, and a promotion forwarded to the manager keeps it. NULL until
-- posted (and on a single-app install, where no app id is known).
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS slack_app_id TEXT;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS slack_team_id TEXT;
