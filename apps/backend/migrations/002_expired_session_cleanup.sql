-- Physical cleanup of expired sessions (D019, D041).
--
-- The backend treats expires_at as authoritative immediately, so this job only
-- reclaims storage. Deleting a session cascades to its requests.
--
-- Requires a superuser connection and a server started with
-- shared_preload_libraries=pg_cron and cron.database_name set to this database.

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
    'qa-tool-delete-expired-sessions',
    '*/10 * * * *',
    $$DELETE FROM sessions WHERE expires_at < now()$$
);
