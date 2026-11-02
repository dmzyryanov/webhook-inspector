-- The record of a default answer names no address its request does not hold
-- (D243, issue #166): the second half of migration 014's rule, for the one
-- other place a capture stores the sender's address for longer than its live
-- event's seconds in realtime_events.
--
-- The default answer says what the list and the detail say of the request,
-- sourceIp included (D223), and its record in request_responses - body,
-- headers, raw_response - is what the detail returns and what a backup keeps
-- (D109). This image builds that answer from the row its insert returned, so
-- for a session created with storeSourceIp false the answer and its record
-- say "sourceIp":null. The previous image builds it from the address it read
-- in the process: during a rolling update (D221) or after a `helm rollback`
-- (D055) its capture into such a session leaves the row without the address -
-- 014's trigger - but writes the address into the answer's record.
--
-- The trigger request_responses_source_ip_choice holds that record to the row,
-- for every writer: a record inserted as a request's default answer, whose
-- sourceIp is a string while the request's row holds no address, is written as
-- this image writes the same answer - the member "sourceIp":"<address>" made
-- "sourceIp":null, the last member, so nothing before it moves; the body's
-- size, the content-length pair, which is the answer's last header, and the
-- raw response's head and body follow it. The result is byte for byte the
-- record this image stores for the same request (source-ip-choice.test.ts).
-- Nothing is refused and nothing is dropped, so no capture of either image
-- can fail or lose its record on it.
--
-- It is recognised exactly, so nothing else is touched: the body starts
-- {"ok":true,"requestId":"<this request's id>", and ends with the member, the
-- address holding no quote and no backslash; the headers end with
-- ["content-length","<the body's size>"]; the raw response is a head ending
-- with that header's line and the blank line, then the body - the head alone
-- for a HEAD, whose body is not sent (D064). That is the shape every image
-- since the nine-key answer (D223) writes it in. A custom response or a queue
-- step is the user's own text, never this request's id, and is never
-- rewritten; neither is a record of any other shape, nor one whose request
-- holds an address: a session that keeps it is unchanged.
--
-- Why rewriting is right here, when D109 records the bytes the backend formed:
-- the sender has had its answer, which names the address it connected from -
-- its own; what is stored is read by anyone holding the session's URL and
-- kept in backups, and the session was created not to keep it. Only that one
-- member changes, to what this image itself answers, and the body is replaced
-- at a fixed place, never re-encoded through JSON.
--
-- Cost: the WHEN clause reads only the new row, so the function is called for
-- a default answer that names an address - every default-answered capture of
-- a session that keeps it - and reads that capture's own request row, just
-- inserted, by its primary key, which says the record may stand. A custom
-- response or a queue step, unless its own text starts and ends as the answer
-- does, and every capture this image makes into a session that keeps no
-- address never call it. The content columns are written once,
-- on the insert (D109), so the trigger is on INSERT only.
--
-- Locks: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on request_responses, which
-- waits for the captures and response completions writing to it at that
-- moment, each a transaction of milliseconds (D105), and holds new ones behind
-- it until this migration commits. It waits at most lock_timeout, 5 s (D221):
-- past that the migration rolls back unrecorded and the backend's init
-- container runs it again. CREATE FUNCTION takes no lock a query waits for.
--
-- The function reads public.requests by its qualified name under a fixed
-- search_path, and EXECUTE is revoked from PUBLIC, as for 014's.
--
-- There is no down-migration (D055), and a recovery never drops the trigger:
-- without it the previous image would store the address in the record of a
-- session created not to keep one.

CREATE FUNCTION public.request_responses_source_ip_choice() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
    old_size integer := octet_length(NEW.body);
    member integer;
    address bytea;
    answer bytea;
    head bytea;
    length_line bytea;
BEGIN
    -- The request's row holds an address, so the record may name it.
    IF NOT EXISTS (
        SELECT 1
        FROM public.requests
        WHERE id = NEW.request_id
          AND source_ip IS NULL
    ) THEN
        RETURN NEW;
    END IF;

    -- This request's default answer: its id after the prefix WHEN checked.
    IF substring(NEW.body FROM 25 FOR 38)
        IS DISTINCT FROM convert_to(NEW.request_id::text || '",', 'UTF8') THEN
        RETURN NEW;
    END IF;

    -- Its last member, "sourceIp":"<address>", before the closing brace.
    member := position(',"sourceIp":"'::bytea IN NEW.body);

    IF member < 63 OR old_size - member - 14 < 1 THEN
        RETURN NEW;
    END IF;

    address := substring(NEW.body FROM member + 13 FOR old_size - member - 14);

    IF position('"'::bytea IN address) > 0
        OR position('\x5c'::bytea IN address) > 0 THEN
        RETURN NEW;
    END IF;

    -- Its last header says the body's size.
    IF NEW.headers -> -1 IS DISTINCT FROM jsonb_build_array('content-length', old_size::text) THEN
        RETURN NEW;
    END IF;

    -- Its raw response: the head, then the body unless it was not sent.
    IF NEW.body_suppressed THEN
        head := NEW.raw_response;
    ELSIF substring(NEW.raw_response FROM octet_length(NEW.raw_response) - old_size + 1)
        IS DISTINCT FROM NEW.body THEN
        RETURN NEW;
    ELSE
        head := substring(NEW.raw_response FOR octet_length(NEW.raw_response) - old_size);
    END IF;

    length_line := convert_to(E'\r\ncontent-length: ' || old_size || E'\r\n\r\n', 'UTF8');

    IF substring(head FROM octet_length(head) - octet_length(length_line) + 1)
        IS DISTINCT FROM length_line THEN
        RETURN NEW;
    END IF;

    answer := substring(NEW.body FOR member - 1) || ',"sourceIp":null}'::bytea;
    head := substring(head FOR octet_length(head) - octet_length(length_line))
        || convert_to(E'\r\ncontent-length: ' || octet_length(answer) || E'\r\n\r\n', 'UTF8');

    NEW.body := answer;
    NEW.body_size := octet_length(answer);
    NEW.headers := jsonb_set(NEW.headers, '{-1,1}', to_jsonb(octet_length(answer)::text));
    NEW.raw_response := CASE WHEN NEW.body_suppressed THEN head ELSE head || answer END;

    RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.request_responses_source_ip_choice() FROM PUBLIC;

CREATE TRIGGER request_responses_source_ip_choice
    BEFORE INSERT ON request_responses
    FOR EACH ROW
    WHEN (substring(NEW.body FOR 24) = '{"ok":true,"requestId":"'::bytea
          AND substring(NEW.body FROM octet_length(NEW.body) - 1) = '"}'::bytea)
    EXECUTE FUNCTION public.request_responses_source_ip_choice();
