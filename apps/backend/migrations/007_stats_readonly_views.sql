-- Read-only usage views and the role that may read them (D170, issue #48).
--
-- Schema `stats` holds two views over the application tables, and role
-- `qa_readonly` may read those two views and nothing else. They exist so that
-- production usage can be inspected through a read-only Postgres MCP server
-- without the superuser and without webhook content: no body, raw request,
-- path, query string, response snapshot or header other than Content-Type and
-- User-Agent; no session id, which is the session's access key (D004), only a
-- short hash of it that still groups requests by session; no full sender
-- address, only its /24 (IPv4) or /48 (IPv6) network.
--
-- The column lists are the approved ones, in order, and a test pins them
-- (stats-views.test.ts). Widening either view, or granting the role any table,
-- is the owner's decision (D170).
--
-- The views pin the columns they read: a later migration that drops or retypes
-- sessions.id, created_at, expires_at or requests.session_id, received_at,
-- method, body_size, headers, source_ip has to recreate the view it breaks.
-- requests.source_country is not read, so its planned drop is unaffected (D140).
--
-- The role is versioned and exists in every environment, including local
-- development and tests, but only as NOLOGIN and without a password. Both are
-- set by hand on production, an operator's step as the superuser
-- (ALTER ROLE qa_readonly LOGIN PASSWORD ...), and nowhere in Git.
-- Roles are cluster-wide while this migration runs once per database, and the
-- local cluster holds the development and browser-smoke databases side by
-- side, so the role is created only when absent and an existing role keeps its
-- LOGIN state: re-running this against another database must never undo, or
-- perform, the operator's step. The role settings below are idempotent.
--
-- Rollback of the application image: the previous image never reads `stats`,
-- so it runs unchanged on this schema. There is no down-migration (D055); the
-- access itself is withdrawn with `ALTER ROLE qa_readonly NOLOGIN`.

CREATE SCHEMA stats;

-- first 12 hex characters of sha256(id): 48 bits, enough to tell a week's
-- sessions apart, and not the key. PostgreSQL's built-in sha256() (11+).
CREATE VIEW stats.sessions AS
SELECT
    left(encode(sha256(convert_to(s.id, 'UTF8')), 'hex'), 12) AS session_key,
    s.created_at,
    s.expires_at
FROM public.sessions AS s;

-- Header names are stored as the sender spelled them (D045, rawHeaders), so
-- they are matched case-insensitively; with duplicates the first one counts.
-- source_ip is TEXT validated by the application (D057, D111), but rows from
-- before D111 were not, so it is checked with pg_input_is_valid (16+) before
-- the cast: one unreadable address must not fail the whole query. Unreadable
-- or missing reads NULL.
CREATE VIEW stats.requests AS
SELECT
    left(encode(sha256(convert_to(r.session_id, 'UTF8')), 'hex'), 12) AS session_key,
    r.received_at,
    r.method,
    r.body_size,
    (
        SELECT left(header.pair ->> 1, 200)
        FROM jsonb_array_elements(r.headers) WITH ORDINALITY AS header (pair, position)
        WHERE lower(header.pair ->> 0) = 'content-type'
        ORDER BY header.position
        LIMIT 1
    ) AS content_type,
    (
        SELECT left(header.pair ->> 1, 200)
        FROM jsonb_array_elements(r.headers) WITH ORDINALITY AS header (pair, position)
        WHERE lower(header.pair ->> 0) = 'user-agent'
        ORDER BY header.position
        LIMIT 1
    ) AS user_agent,
    CASE
        WHEN pg_input_is_valid(r.source_ip, 'inet') THEN
            network(set_masklen(
                r.source_ip::inet,
                CASE family(r.source_ip::inet) WHEN 4 THEN 24 ELSE 48 END
            ))
    END AS sender_net
FROM public.requests AS r;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_readonly') THEN
        CREATE ROLE qa_readonly NOLOGIN;
    END IF;
END
$$;

ALTER ROLE qa_readonly NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 2;
ALTER ROLE qa_readonly SET default_transaction_read_only = on;
ALTER ROLE qa_readonly SET statement_timeout = '5s';

GRANT USAGE ON SCHEMA stats TO qa_readonly;
GRANT SELECT ON stats.sessions, stats.requests TO qa_readonly;

-- What every role gets through PUBLIC, withdrawn so that the grants above are
-- all qa_readonly holds in this database. PostgreSQL 15+ no longer grants
-- CREATE on schema public to PUBLIC, but it still grants USAGE there, and
-- TEMPORARY on the database. The application connects as the bootstrap
-- superuser (D087), which privileges do not limit, and there is no other role.
-- CONNECT stays with PUBLIC: qa_readonly needs it. default_transaction_read_only
-- is only a default a session can switch off, so these privileges are the
-- mechanism, not it.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
