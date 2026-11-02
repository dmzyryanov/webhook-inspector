-- The sender's address, kept or not, per session (D243, issue #166):
-- `storeSourceIp` of POST /api/sessions and of the MCP tool create_session.
--
-- sessions.store_source_ip says whether the session's captures keep the address
-- the backend attributes to their sender, requests.source_ip (D111). The
-- default, true, is what every session did before: adding the column with a
-- constant default is metadata-only on PostgreSQL 16, so the ALTER rewrites no
-- row, and every existing row, and every row the previous image inserts - it
-- never names the column - reads true. The column is set at creation only.
--
-- The trigger requests_source_ip_choice holds the choice for every writer, as
-- sessions_lifetime_cap (011) and sessions_idle_window_cap (013) hold theirs:
-- an INSERT, or an UPDATE of source_ip or session_id, that writes an address
-- into a request of a session whose store_source_ip is false writes NULL in
-- its place. This image never relies on it: its capture reads the column under
-- the session row's lock and writes NULL itself. The previous image keeps
-- running on this schema after a `helm rollback` (D055) and beside this one
-- during a rolling update (D221), and its insert writes the address it read
-- without knowing the column; with the trigger the row keeps none. Nothing is
-- refused, so no capture of either image can fail on it. The WHEN clause skips
-- every row that carries no address, so this image's inserts for such a
-- session never call the function; any other insert - every capture of a
-- session that keeps the address - costs one primary-key read of the session
-- row the capture already holds locked.
--
-- The previous image also writes the address into the default answer it
-- composes and records with the request; migration 015's trigger holds that
-- record to the row. What no trigger reaches (D243): that image builds its
-- live event and the answer it sends from the address it read in the process,
-- so for its captures into such a session the event it sends to open viewers,
-- held in realtime_events for seconds and never in a backup, and the answer
-- the sender itself receives, which names the sender's own address, still
-- carry it. Only that image does so, only while it serves.
--
-- Locks: the ALTER takes ACCESS EXCLUSIVE on sessions and CREATE TRIGGER
-- SHARE ROW EXCLUSIVE on requests, each held until this migration commits.
-- Each waits for the transactions using its table at that moment - a capture
-- holds its session row FOR UPDATE and inserts into requests, for
-- milliseconds (D105) - and holds new ones behind it meanwhile: the ALTER
-- rewrites no row and the trigger scans none, so the wait is the migration's
-- whole cost. It waits at most lock_timeout, 5 s (D221): past that the
-- migration rolls back unrecorded and the backend's init container runs it
-- again.
--
-- The function reads public.sessions by its qualified name under a fixed
-- search_path, and EXECUTE is revoked from PUBLIC, as for record_usage_days
-- (008) and sessions_idle_window_cap (013).
--
-- There is no down-migration (D055), and a recovery never drops the column or
-- the trigger, nor 015's: the previous image never names the column, and
-- without the triggers its captures would store the address a session was
-- created not to keep.

ALTER TABLE sessions
    ADD COLUMN store_source_ip BOOLEAN NOT NULL DEFAULT true;

CREATE FUNCTION public.requests_source_ip_choice() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.sessions
        WHERE id = NEW.session_id
          AND NOT store_source_ip
    ) THEN
        NEW.source_ip := NULL;
    END IF;

    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.requests_source_ip_choice() FROM PUBLIC;

CREATE TRIGGER requests_source_ip_choice
    BEFORE INSERT OR UPDATE OF source_ip, session_id ON requests
    FOR EACH ROW
    WHEN (NEW.source_ip IS NOT NULL)
    EXECUTE FUNCTION public.requests_source_ip_choice();
