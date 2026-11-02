-- The four pg_cron jobs take the inspector's name (D278, issue #323): from
-- 2026-11-01 QA Tools names the platform, and Webhook Inspector the service
-- these jobs belong to.
--
-- Migrations 006, 008, 012 and 020 registered them as qa-tools-<what it
-- does>, and an applied migration is never edited, so the rename is this
-- migration, on 006's pattern (D160): for each job it removes the job under
-- the old name and schedules the same statement, on the same schedule, under
-- webhook-inspector-<the same suffix>. The schedules and statements are
-- copied from 006, 008, 012 and 020, the latest to schedule each.
--
-- Each old job is removed by its id, found by name alone, and not with
-- cron.unschedule('<name>'). pg_cron's by-name form finds only jobs owned by
-- the current user and raises an error when there is none. A database
-- restored from a dump taken before this migration carries the rows as the
-- dump wrote them, which may name a role and a database other than this
-- server's - production's qa_tools while #335 renames it - so the by-name
-- form could fail the migration and leave the backend's init container
-- crash-looping. By id the ownership check passes because the connecting user
-- is the bootstrap superuser (D087). The rows are deliberately not filtered on
-- their database for the same reason.
--
-- Running it again changes nothing: with no old row each removal selects
-- nothing, and cron.schedule updates the job that already has the new name
-- and this user instead of adding a second one.
--
-- Safe while the previous image serves (D221): no image reads cron.job. There
-- is no down-migration (D055); after a rollback the previous image runs
-- unchanged, and the jobs keep the new names.

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'qa-tools-delete-expired-sessions';

SELECT cron.schedule(
    'webhook-inspector-delete-expired-sessions',
    '*/10 * * * *',
    $$DELETE FROM sessions WHERE expires_at < now()$$
);

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'qa-tools-record-usage-days';

SELECT cron.schedule(
    'webhook-inspector-record-usage-days',
    '5 0 * * *',
    $$SELECT public.record_usage_days()$$
);

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'qa-tools-prune-realtime-events';

SELECT cron.schedule(
    'webhook-inspector-prune-realtime-events',
    '* * * * *',
    $$WITH doomed AS MATERIALIZED (SELECT id FROM realtime_events WHERE created_at < clock_timestamp() - interval '5 minutes' FOR UPDATE SKIP LOCKED) DELETE FROM realtime_events AS e USING doomed WHERE e.id = doomed.id$$
);

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'qa-tools-delete-old-sender-nets';

SELECT cron.schedule(
    'webhook-inspector-delete-old-sender-nets',
    '10 0 * * *',
    $$DELETE FROM stats.usage_daily_top WHERE dimension = 'sender_net' AND day < (now() AT TIME ZONE 'UTC')::date - 90$$
);
