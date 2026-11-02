-- The per-request response snapshot (D109).
--
-- The filename names the table, so every column this file adds is listed here
-- rather than left to be discovered: the new request_responses table below,
-- and three nullable columns on requests - path, http_version (D110) and
-- source_country (D111, D118). D118 withdrew the separate
-- 005_source_ip_country.sql; this release ships one migration.
--
-- The three ALTER columns are nullable with no default, so the change is
-- metadata-only and nothing is backfilled: a request captured before this
-- migration reads NULL, which is the honest value for "this was never
-- recorded" (D102). A request captured before it has no response row either,
-- which is a fifth reading of the state and means the same thing (D109).
--
-- There is no down-migration (D055).

CREATE TABLE request_responses (
    -- 1:1 with requests. The cascade covers all four deletion paths: single
    -- delete, Delete all, the newest-1000 eviction (D006) and the scheduled
    -- session cleanup (D019). A request deleted while its response was still
    -- pending stays deleted: the completion write updates and never inserts.
    request_id UUID PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
    -- Only these four are ever stored. `unknown` is derived at read time from
    -- an aged pending row and must never reach this column, which is what the
    -- CHECK is here to guarantee (D109).
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'aborted', 'failed')),
    -- NULL when the write failed before a status was composed (D109).
    status INTEGER,
    -- The exact final ordered pair list passed to writeHead, content-length
    -- included, validated by the function the captured headers already use, so
    -- duplicates and order survive on this side too (D045, D109).
    headers JSONB NOT NULL DEFAULT '[]' CHECK (is_header_pairs(headers)),
    -- The bytes actually written. NULL means there was no body at all; a
    -- zero-length value means an empty body. The two are different answers and
    -- this column has to be able to tell them apart (D109).
    body BYTEA,
    body_size INTEGER NOT NULL DEFAULT 0,
    -- A representation was produced and its bytes were not sent, which is the
    -- HEAD contract. The flag is what makes that visible (D064, D109).
    body_suppressed BOOLEAN NOT NULL DEFAULT false,
    -- The response the backend formed: the status line and the headers the
    -- backend set, then the body. Not a wire capture - the headers Node adds
    -- when it serialises the head (Date, Connection, Keep-Alive) are composed
    -- after this value is built and are not in it. Stored rather than composed
    -- on read: an aborted write leaves nothing to compose from (D109).
    raw_response BYTEA,
    delay_ms INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    -- completed_at - started_at, including the configured delay. A backend-side
    -- measurement of forming and writing: no network transit, no client
    -- processing (D109).
    duration_ms INTEGER
);

ALTER TABLE requests
    -- The path component of the captured URL, without the query string, which
    -- is already its own column. D110 lifts the v0.1 statement that no
    -- separate path field is required.
    ADD COLUMN path TEXT,
    -- The HTTP version the request arrived on, as Node reports it: "1.1".
    ADD COLUMN http_version TEXT,
    -- The country resolved from the sender address (D111). Nothing writes it
    -- in this migration's release step; it reads NULL until MR 2 populates it.
    ADD COLUMN source_country TEXT;
