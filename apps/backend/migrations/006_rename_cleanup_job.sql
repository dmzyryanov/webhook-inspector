-- The expired-session cleanup job takes the qa-tools name (D160, issue #54).
--
-- Migration 002 registered the job as 'qa-tool-delete-expired-sessions', and an
-- applied migration is never edited, so the rename is this migration: it removes
-- the job under the old name and schedules the same statement, on the same
-- schedule, under the new one. Both are copied from 002.
--
-- The old job is removed by its id, found by name alone, and not with
-- cron.unschedule('qa-tool-delete-expired-sessions'). pg_cron's by-name form
-- finds only jobs owned by the current user and raises an error when there is
-- none. In the production database restored from the old namespace the row still
-- belongs to role qa_tool and database qa_tool, neither of which exists any more,
-- so the by-name form would fail this migration and leave the backend's init
-- container crash-looping. By id the ownership check passes because the
-- connecting user is the bootstrap superuser (D087). The row is deliberately not
-- filtered on its database for the same reason.
--
-- Running it again changes nothing: with no old row the first statement selects
-- nothing, and cron.schedule updates the job that already has this name and user
-- instead of adding a second one.
--
-- There is no down-migration (D055). The previous image never reads cron.job,
-- so it runs unchanged after a rollback; the job simply keeps the new name.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'qa-tool-delete-expired-sessions';

SELECT cron.schedule(
    'qa-tools-delete-expired-sessions',
    '*/10 * * * *',
    $$DELETE FROM sessions WHERE expires_at < now()$$
);
