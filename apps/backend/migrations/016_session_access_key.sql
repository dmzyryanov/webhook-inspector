-- A session's access key (D245, issue #98): private sessions, step 1 of 3.
--
-- sessions.access_key_hash is the SHA-256 fingerprint of the session's access
-- key, 32 bytes, never the key itself; NULL is a public session, which every
-- session is until #227 lets a creation set one. A session that carries a
-- fingerprint answers every path that reads or changes it - the API's routes
-- with a session id, POST /api/sessions/status, /ws/:sessionId and the MCP
-- tools - only to a caller that presents its key, and to anyone else exactly
-- as a session that does not exist. The capture on the receive host never
-- reads it: a webhook is captured into such a session as into any other.
--
-- Set at creation only, and nothing changes it later: the API's paths check
-- it before the statement that acts, which is sound because a session's
-- fingerprint is the one it was created with.
--
-- The column is nullable with no default and no backfill, so the ALTER is
-- metadata-only on PostgreSQL 16 and every existing row reads NULL. The
-- constraint keeps a fingerprint at SHA-256's 32 bytes; it is checked against
-- the existing rows, which all read NULL and pass, as sessions_lifetime_cap
-- (011) was.
--
-- The previous image keeps running on this schema after a `helm rollback`
-- (D055) and beside this one during a rolling update (D221). It never names
-- the column, so it reads and creates public sessions as before. It would
-- also serve a keyed session to anyone holding its id, which is why this
-- check ships, and is live on every image that can serve, before #227 lets
-- the first keyed session exist.
--
-- Locks: the ALTER takes ACCESS EXCLUSIVE on sessions until this migration
-- commits, waiting for the transactions using the table at that moment - a
-- capture holds its session row FOR UPDATE for milliseconds (D105) - and
-- holding new ones behind it meanwhile; the constraint's check reads the
-- table once. It waits at most lock_timeout, 5 s (D221): past that the
-- migration rolls back unrecorded and the backend's init container runs it
-- again.
--
-- The stats schema's views name their columns (007), so the read-only role
-- never sees this one. There is no down-migration (D055), and a recovery never
-- drops the column: without it every keyed session would be public.

ALTER TABLE sessions
    ADD COLUMN access_key_hash BYTEA,
    ADD CONSTRAINT sessions_access_key_hash_size
        CHECK (access_key_hash IS NULL OR octet_length(access_key_hash) = 32);
