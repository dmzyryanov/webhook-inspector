-- Daily usage counters that outlive the 7-day session cleanup (D178, issue #49).
--
-- Sessions and their requests are deleted 7 days after last use (D133), so the
-- `stats` views of migration 007 (D170) only ever show the last week. Two tables
-- in schema `stats` keep a history instead: one row of aggregates per UTC day,
-- and the top 20 values of four dimensions per day, kept indefinitely. They hold
-- aggregates only: no session id or hash of one, no full sender address, no
-- body, path or query string. The top table's User-Agent values and sender
-- networks are kept for good by the owner's decision of 2026-09-28 (D178), where
-- the views keep them 7 days.
--
-- A snapshot, not counting at write time: public.record_usage_days() records
-- each finished UTC day once, from what the tables hold when it runs, and a
-- pg_cron job runs it at 00:05 UTC every night. The capture path is untouched.
-- What a snapshot misses - requests deleted, cleared, evicted or expired before
-- their day is recorded, and two columns read when the day is recorded rather
-- than as they were during it - is accepted and documented in D178.
--
-- The migration calls the function once at its end, so the days still in the
-- database are recorded at deployment rather than the next night.
--
-- Rollback of the application image: the previous image never reads `stats` or
-- the function, so it runs unchanged on this schema while the job goes on
-- recording. There is no down-migration (D055).

CREATE TABLE stats.usage_daily (
    -- The UTC day the row describes.
    day DATE PRIMARY KEY,
    -- Sessions created that day.
    sessions_created INTEGER NOT NULL,
    -- Of those, sessions that captured at least one request the same day.
    sessions_created_with_requests INTEGER NOT NULL,
    -- Distinct sessions that captured at least one request that day.
    sessions_with_requests INTEGER NOT NULL,
    -- Of those, sessions created before that day.
    sessions_returning INTEGER NOT NULL,
    -- Requests captured that day.
    requests_captured INTEGER NOT NULL,
    -- Distinct sender networks (/24, /48) that day; a missing or unreadable
    -- address is not counted.
    sender_nets INTEGER NOT NULL,
    -- Over that day's captured requests (body_size), 0 when there were none.
    body_bytes_total BIGINT NOT NULL,
    body_bytes_max INTEGER NOT NULL,
    -- Sessions with requests that day whose custom response is active when the
    -- day is recorded (D151).
    sessions_custom_response INTEGER NOT NULL,
    -- Requests that day sent to a path under the endpoint: more than a lone `/`
    -- after /s/<id> (D173). A NULL path, captured before D110, is not counted.
    requests_with_subpath INTEGER NOT NULL,
    -- Sessions with requests that day that hold the 1000 requests a session
    -- keeps (D006) when the day is recorded.
    sessions_at_request_limit INTEGER NOT NULL,
    -- pg_database_size() when the day is recorded the day after it; NULL for a
    -- day recorded later, since it would be a later day's size.
    database_bytes BIGINT,
    -- When the row was written. A day recorded later than the night after it
    -- is incomplete: what expired in between is missing (D178).
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stats.usage_daily_top (
    day DATE NOT NULL,
    dimension TEXT NOT NULL
        CHECK (dimension IN ('user_agent', 'content_type', 'method', 'sender_net')),
    value TEXT NOT NULL,
    -- Requests that day with this value.
    requests INTEGER NOT NULL,
    -- Distinct sessions among them.
    sessions INTEGER NOT NULL,
    PRIMARY KEY (day, dimension, value)
);

-- The only change to the role: it may read the two tables (D178). It still has
-- no USAGE on schema public, so it cannot call the function below either.
GRANT SELECT ON stats.usage_daily, stats.usage_daily_top TO qa_readonly;

-- Records every UTC day that has no usage_daily row, from the start to
-- yesterday, oldest first, and returns how many it recorded. The start is the
-- day after the latest recorded day; with nothing recorded, the earliest UTC day
-- in sessions.created_at or requests.received_at; with no data at all,
-- yesterday. A day with no activity is a zero row, and a recorded day is never
-- rewritten.
--
-- Day boundaries are UTC, computed with AT TIME ZONE 'UTC' and never from the
-- connection's TimeZone. `yesterday` is taken from now(), the start of the
-- caller's transaction.
--
-- Two overlapping runs change nothing and do not fail: the second waits at the
-- lock until the first commits and, reading afresh as READ COMMITTED does for
-- every statement, finds the days already recorded; ON CONFLICT DO NOTHING
-- keeps a recorded day as it is in any case. Under REPEATABLE READ or
-- SERIALIZABLE the waiting run would not see those rows and would fail on the
-- conflict, so run it as the job and the migration do, under READ COMMITTED.
--
-- The dimension values and sender_nets are read through the stats.requests
-- view, so the header and sender-network rules stay the view's alone (D170
-- item 1), and the top table counts sessions by the view's session_key. What
-- the view does not expose - the session, its state, the path - is read from
-- the tables. Everything is one statement, so every column of a day comes from
-- one snapshot.
--
-- Called by the pg_cron job below and by this migration, as the bootstrap
-- superuser; EXECUTE is revoked from PUBLIC.
CREATE FUNCTION public.record_usage_days() RETURNS INTEGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    yesterday CONSTANT DATE := (now() AT TIME ZONE 'UTC')::date - 1;
    first_day DATE;
    range_start TIMESTAMPTZ;
    range_end TIMESTAMPTZ;
    recorded INTEGER;
BEGIN
    LOCK TABLE stats.usage_daily IN SHARE ROW EXCLUSIVE MODE;

    SELECT max(day) + 1 INTO first_day FROM stats.usage_daily;

    IF first_day IS NULL THEN
        SELECT (least(
                   (SELECT min(created_at) FROM public.sessions),
                   (SELECT min(received_at) FROM public.requests)
               ) AT TIME ZONE 'UTC')::date
          INTO first_day;

        first_day := coalesce(first_day, yesterday);
    END IF;

    IF first_day > yesterday THEN
        RETURN 0;
    END IF;

    range_start := first_day::timestamp AT TIME ZONE 'UTC';
    range_end := (yesterday + 1)::timestamp AT TIME ZONE 'UTC';

    WITH days AS (
        SELECT first_day + offset_days AS day
        FROM generate_series(0, yesterday - first_day) AS offset_days
    ),
    created AS (
        SELECT (s.created_at AT TIME ZONE 'UTC')::date AS day,
               count(*) AS sessions_created
        FROM public.sessions AS s
        WHERE s.created_at >= range_start AND s.created_at < range_end
        GROUP BY 1
    ),
    captured AS (
        SELECT (r.received_at AT TIME ZONE 'UTC')::date AS day,
               r.session_id,
               r.body_size,
               r.path,
               (s.created_at AT TIME ZONE 'UTC')::date AS session_created_day,
               -- The mode as the capture path reads it (D151).
               s.response_status IS NOT NULL AND NOT s.response_custom_disabled
                   AS custom_response
        FROM public.requests AS r
        JOIN public.sessions AS s ON s.id = r.session_id
        WHERE r.received_at >= range_start AND r.received_at < range_end
    ),
    -- What each of those sessions holds now, all days together.
    held AS (
        SELECT r.session_id, count(*) AS requests
        FROM public.requests AS r
        WHERE r.session_id IN (SELECT session_id FROM captured)
        GROUP BY r.session_id
    ),
    per_day AS (
        SELECT c.day,
               count(DISTINCT c.session_id) FILTER (WHERE c.session_created_day = c.day)
                   AS sessions_created_with_requests,
               count(DISTINCT c.session_id) AS sessions_with_requests,
               count(DISTINCT c.session_id) FILTER (WHERE c.session_created_day < c.day)
                   AS sessions_returning,
               count(*) AS requests_captured,
               sum(c.body_size) AS body_bytes_total,
               max(c.body_size) AS body_bytes_max,
               count(DISTINCT c.session_id) FILTER (WHERE c.custom_response)
                   AS sessions_custom_response,
               -- `/s/` and the segment after it name the session, as the detail
               -- header cuts them (splitRequestTarget, D173); a lone `/` after
               -- them is not a path. A path that does not match is not counted.
               count(*) FILTER (
                   WHERE substring(c.path FROM '^/s/[^/]*(.*)$') NOT IN ('', '/')
               ) AS requests_with_subpath,
               -- MAX_REQUESTS_PER_SESSION in packages/shared (D006).
               count(DISTINCT c.session_id) FILTER (WHERE h.requests >= 1000)
                   AS sessions_at_request_limit
        FROM captured AS c
        JOIN held AS h ON h.session_id = c.session_id
        GROUP BY c.day
    ),
    seen AS (
        SELECT (v.received_at AT TIME ZONE 'UTC')::date AS day,
               v.session_key,
               v.method,
               v.content_type,
               v.user_agent,
               v.sender_net
        FROM stats.requests AS v
        WHERE v.received_at >= range_start AND v.received_at < range_end
    ),
    nets AS (
        SELECT seen.day, count(DISTINCT seen.sender_net) AS sender_nets
        FROM seen
        GROUP BY seen.day
    ),
    -- Ranked by requests, then by value in byte order (COLLATE "C"), so the
    -- cut at 20 does not depend on the database's collation.
    ranked AS (
        SELECT seen.day,
               value_of.dimension,
               value_of.value,
               count(*) AS requests,
               count(DISTINCT seen.session_key) AS sessions,
               row_number() OVER (
                   PARTITION BY seen.day, value_of.dimension
                   ORDER BY count(*) DESC, value_of.value COLLATE "C"
               ) AS position
        FROM seen
        CROSS JOIN LATERAL (
            VALUES
                ('user_agent', coalesce(seen.user_agent, '<none>')),
                -- The media type alone: parameters after `;` dropped, trimmed,
                -- lower case, at most 200 characters.
                ('content_type', coalesce(
                    left(lower(btrim(split_part(seen.content_type, ';', 1), E' \t')), 200),
                    '<none>'
                )),
                ('method', seen.method),
                ('sender_net', coalesce(seen.sender_net::text, '<unknown>'))
        ) AS value_of (dimension, value)
        GROUP BY seen.day, value_of.dimension, value_of.value
    ),
    recorded_days AS (
        INSERT INTO stats.usage_daily (
            day,
            sessions_created,
            sessions_created_with_requests,
            sessions_with_requests,
            sessions_returning,
            requests_captured,
            sender_nets,
            body_bytes_total,
            body_bytes_max,
            sessions_custom_response,
            requests_with_subpath,
            sessions_at_request_limit,
            database_bytes
        )
        SELECT d.day,
               coalesce(created.sessions_created, 0),
               coalesce(per_day.sessions_created_with_requests, 0),
               coalesce(per_day.sessions_with_requests, 0),
               coalesce(per_day.sessions_returning, 0),
               coalesce(per_day.requests_captured, 0),
               coalesce(nets.sender_nets, 0),
               coalesce(per_day.body_bytes_total, 0),
               coalesce(per_day.body_bytes_max, 0),
               coalesce(per_day.sessions_custom_response, 0),
               coalesce(per_day.requests_with_subpath, 0),
               coalesce(per_day.sessions_at_request_limit, 0),
               CASE WHEN d.day = yesterday THEN pg_database_size(current_database()) END
        FROM days AS d
        LEFT JOIN created ON created.day = d.day
        LEFT JOIN per_day ON per_day.day = d.day
        LEFT JOIN nets ON nets.day = d.day
        ORDER BY d.day
        ON CONFLICT (day) DO NOTHING
        RETURNING day
    ),
    -- Only for the days this run recorded: a day recorded before keeps its
    -- values as they were.
    recorded_top AS (
        INSERT INTO stats.usage_daily_top (day, dimension, value, requests, sessions)
        SELECT ranked.day, ranked.dimension, ranked.value, ranked.requests, ranked.sessions
        FROM ranked
        WHERE ranked.position <= 20
          AND ranked.day IN (SELECT recorded_days.day FROM recorded_days)
    )
    SELECT count(*) INTO recorded FROM recorded_days;

    RETURN recorded;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.record_usage_days() FROM PUBLIC;

-- The D160 naming. pg_cron reads the schedule in cron.timezone, GMT by default,
-- and neither the chart nor docker-compose.yml sets it, so the job runs at
-- 00:05 UTC (03:05 in Moscow), five minutes after the day it records has ended.
-- The 00:00 UTC backup (D176) may still be running then; its dump reads one
-- consistent snapshot, so the two do not interfere. cron.schedule updates the
-- job that already has this name and user, so running this again keeps one
-- job, as in 006.
SELECT cron.schedule(
    'qa-tools-record-usage-days',
    '5 0 * * *',
    $$SELECT public.record_usage_days()$$
);

SELECT public.record_usage_days();
