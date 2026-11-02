-- Sessions deleted through the API, counted per UTC day (D198, issue #102).
--
-- `DELETE /api/sessions/{sessionId}` removes a session with everything it
-- held, so a session created and deleted within one UTC day never reaches the
-- nightly snapshot of migration 008 (D178): the snapshot counts what the
-- tables hold when the day is recorded. This table counts the deletions
-- themselves, at write time: the route adds one session and the requests that
-- session held to the row of the UTC day of the deletion, in the transaction
-- that deletes it, so the count and the deletion commit or roll back together.
--
-- Aggregates only, as D178 requires of schema `stats`: no session id, no hash
-- of one, nothing about the requests but their number. The expiry cleanup
-- (002, 006) is not counted here; it deletes expired sessions, not deleted
-- ones.
--
-- The only change to the role: it may read this table (owner, 2026-10-03,
-- D198). Role `qa_readonly` exists in every environment since 007, which
-- creates it where it is absent, so the grant needs no guard, as in 008.
--
-- Rollback of the application image: the previous image never reads or writes
-- `stats`, so it runs unchanged on this schema, and the table simply stops
-- growing while it runs. There is no down-migration (D055).

CREATE TABLE stats.deletions_daily (
    -- The UTC day of the deletions the row counts.
    day DATE PRIMARY KEY,
    -- Sessions deleted through the API that day.
    sessions_deleted BIGINT NOT NULL CHECK (sessions_deleted >= 0),
    -- The requests those sessions held when they were deleted.
    requests_held BIGINT NOT NULL CHECK (requests_held >= 0)
);

GRANT SELECT ON stats.deletions_daily TO qa_readonly;
