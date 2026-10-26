-- What a background slot carries to the next period (spec §9.2, Task 9). The
-- weekly digest stores the lessons page as it showed it, so the next digest
-- lists the lessons added and dropped since; NULL for every other slot (and
-- for a digest that reached nobody, so the next one still shows the changes).
ALTER TABLE background_slots ADD COLUMN IF NOT EXISTS state TEXT;
