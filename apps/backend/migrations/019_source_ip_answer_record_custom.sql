-- The record of a custom answer is stored as sent (D251, issue #135): migration
-- 015's trigger rewrites only the record of a default answer.
--
-- 015's trigger, request_responses_source_ip_choice, holds the record of the
-- default answer an image before 1.2.0 writes, naming the sender's address for
-- a session created with storeSourceIp false, to the request's row (D243). It
-- recognised that answer by its shape alone - the body starting
-- {"ok":true,"requestId":"<this request's id>", and ending with a
-- "sourceIp":"<address>" member, the last header its length, the raw response
-- its head and body - on the ground that a custom response or a queue step is
-- the user's own text and never holds this request's id. A template (D251)
-- makes that false: {{request.id}} puts the id where the default answer has
-- it, and {{request.query.ip}} can end the body with such a member, so a
-- template in the default answer's shape answering such a session had its
-- record rewritten to "sourceIp":null - its body, size, content-length and raw
-- response no longer the bytes sent - as the session response, a queue's step
-- or a rule's response alike.
--
-- So the function now also asks which response answered, before anything
-- else: a record of an answer a queue's step gave (queue_step_index, 010) or a
-- rule gave (rule_index, 017), or written while the request's session answers
-- with its custom response (response_status set and response_custom_disabled
-- not true, 003 and 005 - the mode every image since D151 answers by, as
-- toResponseConfig does), is stored as written. That is the user's own
-- response, filled in or not, and what it holds of the request - a query
-- parameter, a header, a body field - the request's row holds already; no
-- placeholder names the sender's address. The capture reads the session row
-- FOR UPDATE before it writes the record, and every change of the response
-- takes that lock (D150), so the session the function reads is the one the
-- answer was chosen from. Every check of 015's stays as it was, after these.
--
-- What it still holds: the default answer of an image before 1.2.0 - the one
-- that builds it from the address it read - is written only when no step and
-- no rule answered and the session answers the default, which is exactly what
-- the function now asks, so its record is rewritten as before; 1.1.0's
-- statements are replayed in source-ip-choice.test.ts, a session switched to
-- the default while keeping its custom response among them. Every image since
-- 1.2.0 builds its default answer from the row, so for such a session it says
-- "sourceIp":null, ends with null}, and never calls the function; no image
-- before 1.9.0 fills in a template, so none of their custom records changes
-- outcome. The trigger and its WHEN clause are not touched, and a recovery
-- still never drops it (015).
--
-- Cost: one more read, by primary key, of the session row the capture already
-- holds locked, joined to the request's own row in the statement that already
-- reads it, and only for a record whose body starts and ends as a default
-- answer does; a record of a step or a rule returns before any read.
--
-- Locks: CREATE OR REPLACE FUNCTION changes the function's catalog row and
-- takes no lock on request_responses, so no capture waits for it. A capture in
-- flight runs the function as it was or as it is now, and either stores the
-- previous image's record the same; no 1.9.0 capture, the only writer of a
-- template, runs before this migration commits, since its init container runs
-- it first. The function keeps its owner and its privileges; its search_path
-- is set again, since OR REPLACE replaces it, and EXECUTE is revoked from
-- PUBLIC again so this file states it alone.
--
-- A second migration rather than a change to 018: the runner records a
-- migration by its name only (D055), so every database that has applied 018 -
-- each task's test database, a developer's own - would never run a changed one.
-- There is no down-migration (D055).

CREATE OR REPLACE FUNCTION public.request_responses_source_ip_choice() RETURNS trigger
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
    -- A queue's step or a rule answered: the user's own response.
    IF NEW.queue_step_index IS NOT NULL OR NEW.rule_index IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- The request's row holds an address, so the record may name it; or its
    -- session answers with its custom response, the user's own.
    IF NOT EXISTS (
        SELECT 1
        FROM public.requests AS r
        JOIN public.sessions AS s ON s.id = r.session_id
        WHERE r.id = NEW.request_id
          AND r.source_ip IS NULL
          AND (s.response_status IS NULL OR s.response_custom_disabled IS TRUE)
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
