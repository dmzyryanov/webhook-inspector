-- The realtime outbox (D221, issue #132): every event a viewer or a list call
-- held by `wait` must hear of is written here, in the transaction of the change
-- it announces. Every backend process reads the rows committed since its last
-- read - when its own process has committed one, when another process's
-- wake-up arrives on the channel `realtime_events`, and once a second - and
-- delivers those its own viewers want, in id order. So a change made by one
-- process reaches the viewers of every process, in the order D205 point 12
-- requires.
--
-- One row per event: `kind` is the event's wire type, or `close` for a
-- session's deletion, which closes its viewers (D198); `payload` is the event
-- exactly as it is sent, or NULL - always for `close`, and for any event whose
-- data a deletion has purged (`forgetEvents`); `request_id` names the request
-- whose captured data the payload carries (`request.received`,
-- `response.recorded`), so that deleting it purges them; `tx` is the writing
-- transaction's id, which a reader's floor is taken from (below). No foreign
-- key: a `close` outlives its session, and a capture's event must not hold up
-- the deletion of its request.
--
-- What the ordering rests on (D221): the identity keeps PostgreSQL's default
-- CACHE 1, so ids are drawn in the order the inserts run, and an event that
-- must follow another is inserted after that other committed - under the
-- session row's lock, or after it causally - so it has the larger id. A reader
-- takes, in one statement, the snapshot's horizon (`pg_snapshot_xmin`) and
-- every row whose `tx` is at or above the horizon its previous read returned,
-- and delivers what it had not seen in id order: no row that can still become
-- visible is ever below the floor. Hence the index on `tx`.
--
-- UNLOGGED: a row matters for seconds, from its commit until each process has
-- read it, and an unlogged table writes no WAL. A crash of the server empties
-- it, and drops every reader's connection with it, which every process treats
-- as a lost channel: its viewers reconnect and reload (D077), so no row is
-- missed silently. Its identity counts from 1 again then; a reader keeps
-- nothing across a reconnection.
--
-- Each backend process deletes, every 5 s, the rows older than 20 s whose
-- writing transaction is below the horizon it read two prunes earlier, so a
-- row is never deleted before every process could have read it, and vacuums
-- the table after a prune that deleted 1 MiB of payload or more, so that a
-- flood of large events writes into the space of the rows it deleted rather
-- than growing the table (D221 point 9). The job below deletes, every minute,
-- what is older than five minutes, for a database no process prunes - after a
-- rollback to an image without the outbox, say. Neither waits for a row lock:
-- each locks the rows it deletes `FOR UPDATE SKIP LOCKED` and leaves a row a
-- deletion's purge holds to its next run, so neither can be in a deadlock with
-- that purge, which PostgreSQL would end by failing one of them. Autovacuum reclaims the
-- deleted rows after 1,000 of them, not after a fifth of the table, and on
-- this table at full speed, with no cost delay: it is the backstop of the
-- processes' vacuum, and the only one after such a rollback. Every vacuum of
-- the table and of its TOAST table cleans the indexes, however few rows died,
-- so that the line pointers of dead rows are removed and the empty pages at
-- the end of each go back to the disk.
--
-- Safe while the previous image serves (D221; MR B makes it the rule for every
-- migration): creating a table, its indexes and a job takes no lock any query
-- of the previous image waits for, and the previous image never reads this
-- table or this job. A rollback to an image without the outbox leaves them in
-- place, emptied within about six minutes, and harmless. There is no
-- down-migration (D055).
--
-- The read-only role qa_readonly (migration 007) has no USAGE on schema public
-- and no privilege on this table, so it cannot read a payload;
-- stats-views.test.ts holds it.

CREATE UNLOGGED TABLE realtime_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tx xid8 NOT NULL DEFAULT pg_current_xact_id(),
    session_id TEXT NOT NULL,
    request_id UUID,
    kind TEXT NOT NULL,
    payload TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT realtime_events_close_has_no_payload CHECK (kind <> 'close' OR payload IS NULL)
) WITH (
    autovacuum_vacuum_scale_factor = 0,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_vacuum_cost_delay = 0,
    vacuum_index_cleanup = on,
    toast.autovacuum_vacuum_scale_factor = 0,
    toast.autovacuum_vacuum_threshold = 1000,
    toast.autovacuum_vacuum_cost_delay = 0,
    toast.vacuum_index_cleanup = on
);

-- A reader's floor is a transaction id; a deletion purges a session's rows;
-- the prunes delete by age.
CREATE INDEX realtime_events_tx ON realtime_events (tx);
CREATE INDEX realtime_events_session ON realtime_events (session_id);
CREATE INDEX realtime_events_created_at ON realtime_events (created_at);

-- Five minutes is far past the time a listening process needs a row for: from
-- its commit until the process has read it, a second or so, and a process
-- that has read nothing for 5 s gives its channel up, after which it reads no
-- earlier row again (D221 point 7). A row's `created_at` is its insert, the
-- last statement before its transaction's `COMMIT`, so a row is five minutes
-- old about five minutes after it became visible, however long before the
-- append its transaction began.
SELECT cron.schedule(
    'qa-tools-prune-realtime-events',
    '* * * * *',
    $$WITH doomed AS MATERIALIZED (SELECT id FROM realtime_events WHERE created_at < clock_timestamp() - interval '5 minutes' FOR UPDATE SKIP LOCKED) DELETE FROM realtime_events AS e USING doomed WHERE e.id = doomed.id$$
);
