-- The response queue (D205, issue #106): up to 10 responses layered over the
-- session response, each answering one captured request in order, and the
-- step that answered each request.
--
-- sessions.response_queue holds the steps as a JSON array of 1 to 10 complete
-- responses, each at its effective values ({"status", "headers", "body",
-- "delayMs"}), exactly as the API writes them; NULL means the session has no
-- queue. sessions.response_queue_answered counts the steps that have answered
-- a request since the queue was last started: the next request gets step
-- answered + 1, and once it equals the length every request gets the session
-- response again. It is NULL exactly when there is no queue.
--
-- request_responses.queue_step_index and queue_step_total record the step that
-- answered a request - its position, 1-based, and the queue's length at that
-- moment - and are NULL when the session response answered it.
--
-- Every column is nullable with no default, so the ALTERs write no row and
-- backfill nothing; the CHECKs are verified against existing rows, where every
-- new column reads NULL and passes. There is no down-migration (D055).
--
-- The previous image on this schema (D055, D151): it names its columns in
-- every statement, so it never reads these. A session it creates has no queue,
-- a response record it writes has no step, and every request it answers gets
-- the session response, a saved queue included - ignored, not lost, and where
-- the new image left it once that image is back. Its clear of the requests
-- does not start a queue again. The owner accepted this for #106 (Scope 1.10);
-- session-queue.test.ts replays its statements on this schema.

ALTER TABLE sessions
    -- CASE, not AND: SQL does not promise to evaluate the length after the
    -- type, and jsonb_array_length raises on anything but an array.
    ADD COLUMN response_queue JSONB
        CHECK (
            CASE
                WHEN response_queue IS NULL THEN true
                WHEN jsonb_typeof(response_queue) = 'array'
                    THEN jsonb_array_length(response_queue) BETWEEN 1 AND 10
                ELSE false
            END
        ),
    ADD COLUMN response_queue_answered INTEGER CHECK (response_queue_answered >= 0),
    ADD CONSTRAINT sessions_response_queue_position CHECK (
        (response_queue IS NULL AND response_queue_answered IS NULL)
        OR (
            response_queue IS NOT NULL
            AND response_queue_answered IS NOT NULL
            AND response_queue_answered <= jsonb_array_length(response_queue)
        )
    );

ALTER TABLE request_responses
    ADD COLUMN queue_step_index INTEGER CHECK (queue_step_index BETWEEN 1 AND 10),
    ADD COLUMN queue_step_total INTEGER CHECK (queue_step_total BETWEEN 1 AND 10),
    ADD CONSTRAINT request_responses_queue_step CHECK (
        (queue_step_index IS NULL AND queue_step_total IS NULL)
        OR (
            queue_step_index IS NOT NULL
            AND queue_step_total IS NOT NULL
            AND queue_step_index <= queue_step_total
        )
    );
