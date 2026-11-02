-- Custom webhook response configuration, chosen at session creation and
-- immutable afterwards (D099, D101).
--
-- All four columns are nullable and have no default, so this is a
-- metadata-only ALTER: existing rows keep NULL and are not backfilled.
-- response_status IS NULL is the single indicator of a default session (D102).

ALTER TABLE sessions
    -- One final HTTP response; 1xx and 600+ are not configurable (D101).
    ADD COLUMN response_status INTEGER CHECK (response_status BETWEEN 200 AND 599),
    -- Ordered [name, value] pairs, duplicates preserved, validated by the
    -- function the captured headers already use (D045).
    ADD COLUMN response_headers JSONB CHECK (is_header_pairs(response_headers)),
    -- Exact bytes to return, stored as TEXT rather than jsonb so that key
    -- order, duplicate keys and whitespace survive (D101). NULL means no body.
    ADD COLUMN response_body TEXT,
    ADD COLUMN response_delay_ms INTEGER CHECK (response_delay_ms BETWEEN 0 AND 30000);
