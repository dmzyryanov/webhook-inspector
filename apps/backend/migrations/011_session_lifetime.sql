-- An optional lifetime at creation (D220, issue #129): `expiresInSeconds` of
-- POST /api/sessions and of the MCP tool create_session, 60 to 604800.
--
-- sessions.lifetime_ends_at is the fixed end of that lifetime, set at creation
-- to the same instant as expires_at; NULL means the session has none and
-- expires 7 days after its last use, as every session did before (D133).
-- expires_at stays the one column every expiry check, the cleanup job and the
-- statistics read: a lifetime only stops the refresh from moving it, which
-- `AND lifetime_ends_at IS NULL` in the refresh statement does.
--
-- sessions_lifetime_cap keeps expires_at at or before the end of the
-- lifetime, so that nothing can extend such a session - in particular the
-- previous image, which keeps running on this schema after a `helm rollback`
-- (D055) or beside this one during a rolling update. Its refresh moves
-- expires_at 7 days ahead without knowing the column; on a session with a
-- lifetime the constraint refuses that update (SQLSTATE 23514), and the
-- savepoint the previous image already runs it in (D133) turns the refusal
-- into "keeps its previous expiry", with at most one warning a minute, while
-- its capture or response change commits. A session it creates names no
-- lifetime and gets NULL. Moving expires_at back, as an expiry does, always
-- satisfies the constraint.
--
-- The column is nullable with no default, so the ALTER writes no row and
-- backfills nothing; the constraint is checked against existing rows, where
-- lifetime_ends_at reads NULL and passes. There is no down-migration (D055),
-- and a recovery never drops the column: the previous image never names it.

ALTER TABLE sessions
    ADD COLUMN lifetime_ends_at TIMESTAMPTZ,
    ADD CONSTRAINT sessions_lifetime_cap
        CHECK (lifetime_ends_at IS NULL OR expires_at <= lifetime_ends_at);
