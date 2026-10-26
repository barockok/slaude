-- The model a background run's CLI reported that the price table has no price
-- for, when that ended the run as `error` (final review N1). Any such row on a
-- persona-local day refuses every further background start of that agent for
-- the rest of the day: its real cost is unknown, so the budget cannot bound it.
ALTER TABLE background_runs ADD COLUMN IF NOT EXISTS unpriced_model TEXT;
