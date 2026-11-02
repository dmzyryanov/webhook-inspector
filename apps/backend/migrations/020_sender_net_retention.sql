-- Sender networks in the daily usage statistics are kept 90 days (D254, issue
-- #165), by the owner's decision of 2026-10-10, which amends D178 for them
-- alone. Everything else in schema `stats` - the daily totals of usage_daily
-- and deletions_daily, and the top table's User-Agent values, content types
-- and methods - is still kept indefinitely.
--
-- A pg_cron job of its own, by the D160 naming, deletes every night the
-- `sender_net` rows of stats.usage_daily_top whose UTC day is more than 90
-- days before the UTC day it runs on: on day T, days T-90 to T-1 stay and
-- T-91 and older go, `<unknown>` among them. The day is computed with
-- AT TIME ZONE 'UTC', never from the connection's TimeZone, as 008 computes
-- its days. pg_cron reads the schedule in cron.timezone, GMT by default and
-- set by neither the chart nor docker-compose.yml, so the job runs at 00:10
-- UTC, five minutes after qa-tools-record-usage-days (008) has recorded
-- yesterday: a day that job records late, already past 90 days, loses its
-- networks the same night. A removed row is never recorded again:
-- record_usage_days() records only a day with no usage_daily row, and those
-- rows stay. The 00:00 UTC backup (D176) runs before both jobs, so each dump
-- holds the rows its night removes, up to 3 days longer, as /privacy says.
--
-- The job's command is the statement itself, not a function: a CREATE OR
-- REPLACE of record_usage_days() would copy 008's function to drift from it,
-- and a new function would make an older dump fail to restore, as the backup
-- runbook's step 4 describes for 008. qa_readonly holds SELECT alone on the
-- table and no USAGE on schema cron, so it can neither run the statement nor
-- change the job.
--
-- The migration runs the same statement once at its end, so whatever is
-- already older than 90 days goes at deployment rather than the next night.
-- cron.schedule updates the job that already has this name and user, so
-- running this again keeps one job, as in 006 and 008. A second run of the
-- statement finds nothing more to remove, and two overlapping runs do not
-- fail: under READ COMMITTED the second waits for the rows the first is
-- deleting and then skips them.
--
-- Safe while the previous image serves (D221): the statement takes ROW
-- EXCLUSIVE on stats.usage_daily_top and row locks on what it removes, and
-- no image reads `stats`. Rollback of the application image: the previous
-- image never reads `stats` or cron.job, so it runs unchanged on this schema
-- while the job goes on removing. There is no down-migration (D055); a
-- recovery leaves the job in place, and removed rows come back only from a
-- nightly dump.

SELECT cron.schedule(
    'qa-tools-delete-old-sender-nets',
    '10 0 * * *',
    $$DELETE FROM stats.usage_daily_top WHERE dimension = 'sender_net' AND day < (now() AT TIME ZONE 'UTC')::date - 90$$
);

DELETE FROM stats.usage_daily_top WHERE dimension = 'sender_net' AND day < (now() AT TIME ZONE 'UTC')::date - 90;
