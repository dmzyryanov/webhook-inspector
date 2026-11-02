-- Whether a session with a saved custom response answers it or the default
-- (D151, amending D102).
--
-- A session's response can be changed while it runs (D150), and picking the
-- default keeps the custom response saved so that switching back restores it.
-- "A custom response is saved" (response_status IS NOT NULL) and "the custom
-- response is active" are therefore two facts, and this column is the second.
--
-- The column is a flag whose default means "behave as before": a session is
-- custom exactly when response_status IS NOT NULL AND NOT
-- response_custom_disabled. That is what makes the migration safe under the
-- previous image, which keeps running on this schema after a `helm rollback`
-- (D055) and inserts sessions without knowing the column: its rows get
-- `false`, so a custom session it creates stays custom and a default one stays
-- default. A mode column defaulting to 'default' would have silently turned
-- every custom session created by the previous image into a default one.
--
-- NOT NULL with a constant default is metadata-only in PostgreSQL 11+: no
-- table rewrite, and no backfill. Every existing row reads `false`, which is
-- exactly what it meant before this column existed.
--
-- There is no down-migration (D055).

ALTER TABLE sessions
    ADD COLUMN response_custom_disabled BOOLEAN NOT NULL DEFAULT false;
