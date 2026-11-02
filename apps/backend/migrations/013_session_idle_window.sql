-- An idle window at creation (D242, issue #158): `expiresAfterIdleSeconds` of
-- POST /api/sessions and of the MCP tool create_session, 3600 to 604800.
--
-- sessions.idle_seconds is the window a session slides by: creation sets
-- expires_at that far ahead, and every use (D133) moves it a full window from
-- now again, throttled to least(1 hour, window / 10). The default, 604800, is
-- the 7 days every session slid by before: adding the column with a constant
-- default is metadata-only on PostgreSQL 16, so the ALTER rewrites no row, and
-- every existing row, and every row the previous image inserts - it never names
-- the column - reads 604800, which is what it already lives by. A session
-- created with a lifetime (D220, lifetime_ends_at) keeps the default here and
-- never slides; the API reports its window as null.
--
-- sessions_idle_window_range holds the column to the bounds the API takes. It
-- is checked against existing rows, which all read the default and pass.
--
-- The trigger sessions_idle_window_cap holds the window for every writer, as
-- sessions_lifetime_cap holds a lifetime (D220), since a CHECK cannot read the
-- clock: an UPDATE that sets expires_at on a session that slides gets at most
-- clock_timestamp() + its window. The previous image keeps running on this
-- schema after a `helm rollback` (D055) and beside this one during a rolling
-- update (D221); its refresh moves expires_at 7 days ahead without knowing the
-- column, so on a session of a shorter window it would keep that session a week.
-- With the trigger its refresh leaves such a session a full window from now,
-- as this image's refresh does, and never fails: nothing is refused, so its
-- savepoint (D133) has nothing to report. Moving expires_at back, as an expiry
-- does, is always below the cap and left as written. A session with a lifetime
-- is left to sessions_lifetime_cap, which refuses a move past its end.
--
-- There is no down-migration (D055), and a recovery never drops the column or
-- the trigger: the previous image never names the column, and without the
-- trigger its refresh would keep a short session a week.

ALTER TABLE sessions
    ADD COLUMN idle_seconds INTEGER NOT NULL DEFAULT 604800,
    ADD CONSTRAINT sessions_idle_window_range
        CHECK (idle_seconds BETWEEN 3600 AND 604800);

-- A trigger function cannot be called but as a trigger; EXECUTE is revoked
-- from PUBLIC all the same, as for record_usage_days (008).
CREATE FUNCTION public.sessions_idle_window_cap() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF NEW.lifetime_ends_at IS NULL THEN
        NEW.expires_at := least(
            NEW.expires_at,
            clock_timestamp() + make_interval(secs => NEW.idle_seconds)
        );
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.sessions_idle_window_cap() FROM PUBLIC;

CREATE TRIGGER sessions_idle_window_cap
    BEFORE UPDATE OF expires_at ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION public.sessions_idle_window_cap();
