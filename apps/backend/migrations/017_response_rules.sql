-- Response rules by path and method (D246, issue #134): up to 20 ordered
-- rules over the response queue and the session response, and the rule that
-- answered each request.
--
-- sessions.response_rules holds the rules as a JSON array of 1 to 20 objects,
-- each {"method", "path", "response"} - the method in upper case or null for
-- any method, the path pattern as typed, the response at its effective values
-- ({"status", "headers", "body", "delayMs"}) - exactly as the API writes them;
-- NULL means the session has no rules, which is how an empty list is saved.
-- A capture matches them under the session row's lock, in the statement that
-- takes it, and reads only the rule that matched.
--
-- request_responses.rule_index, rule_method and rule_path record the rule that
-- answered a request - its position, 1-based, its method (NULL for any) and
-- its path pattern, as they were when it answered - and rule_index is NULL
-- when no rule did, the queue or the session response answering; rule_method
-- and rule_path are then NULL too. The response it answered with is the
-- record's own content.
--
-- Every column is nullable with no default, so the ALTERs write no row and
-- backfill nothing; each CHECK reads the table once, where every new column
-- reads NULL and passes, as migration 010's did. There is no down-migration
-- (D055).
--
-- The previous image on this schema - beside this one during a rolling update
-- (D221), alone after a `helm rollback` (D055): it names its columns in every
-- statement, so it never reads these. A session it creates has no rules, a
-- response record it writes names no rule, and every request it answers gets
-- the queue's next step or the session response, saved rules included -
-- ignored, not lost, and answering again once this image serves. Its
-- session.updated carries no rules, which a client must not read as "no
-- rules" (#226). session-rules.test.ts replays its statements on this schema.
--
-- Locks: each ALTER takes ACCESS EXCLUSIVE on its table until this migration
-- commits, waiting for the transactions using it at that moment - a capture
-- holds its session row FOR UPDATE and writes its record for milliseconds
-- (D105) - and holding new ones behind it meanwhile. It waits at most
-- lock_timeout, 5 s (D221): past that the migration rolls back unrecorded and
-- the backend's init container runs it again.
--
-- The stats schema's views name their columns (007), so the read-only role
-- never sees these.

ALTER TABLE sessions
    -- CASE, not AND: SQL does not promise to evaluate the length after the
    -- type, and jsonb_array_length raises on anything but an array.
    ADD COLUMN response_rules JSONB
        CHECK (
            CASE
                WHEN response_rules IS NULL THEN true
                WHEN jsonb_typeof(response_rules) = 'array'
                    THEN jsonb_array_length(response_rules) BETWEEN 1 AND 20
                ELSE false
            END
        );

ALTER TABLE request_responses
    ADD COLUMN rule_index INTEGER CHECK (rule_index BETWEEN 1 AND 20),
    ADD COLUMN rule_method TEXT,
    ADD COLUMN rule_path TEXT,
    ADD CONSTRAINT request_responses_rule CHECK (
        (rule_index IS NULL AND rule_method IS NULL AND rule_path IS NULL)
        OR (rule_index IS NOT NULL AND rule_path IS NOT NULL)
    ),
    -- A request is answered by a rule or by a step of the queue, never both.
    ADD CONSTRAINT request_responses_rule_or_step CHECK (
        rule_index IS NULL OR queue_step_index IS NULL
    );
