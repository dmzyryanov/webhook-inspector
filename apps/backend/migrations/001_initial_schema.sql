-- Initial schema for the Webhook Inspector.
--
-- Field semantics are documented in docs/ARCHITECTURE.md; the decisions behind
-- the types are cited by their numbers (D004, D019, ...).

CREATE TABLE sessions (
    -- 32 random bytes encoded as Base64URL without padding (D004).
    id TEXT PRIMARY KEY CHECK (char_length(id) = 43),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Authoritative expiration (D019). Set at creation and then moved forward
    -- by each use of the session - a captured webhook or a load of its View
    -- page - to 7 days from that moment (D133, amending D005's fixed 72 hours).
    expires_at TIMESTAMPTZ NOT NULL
);

-- Supports the scheduled cleanup of expired sessions.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Validates the header representation required by D045: an ordered array of
-- [name, value] pairs, both strings. A CHECK constraint cannot contain a
-- subquery, so the test lives in an IMMUTABLE function.
CREATE FUNCTION is_header_pairs(header_pairs JSONB) RETURNS BOOLEAN
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT jsonb_typeof(header_pairs) = 'array'
       AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(header_pairs) AS element(pair)
           WHERE jsonb_typeof(pair) <> 'array'
              OR jsonb_array_length(pair) <> 2
              OR jsonb_typeof(pair -> 0) <> 'string'
              OR jsonb_typeof(pair -> 1) <> 'string'
       );
$$;

CREATE TABLE requests (
    -- UUID v4; the UI shows the first 7 characters (D044).
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Raw query string exactly as received, without the leading '?'.
    query_string TEXT NOT NULL DEFAULT '',
    -- Ordered array of [name, value] pairs so duplicate headers survive (D045).
    headers JSONB NOT NULL CHECK (is_header_pairs(headers)),
    -- Raw bytes; the payload is not assumed to be valid UTF-8 (D032).
    body BYTEA NOT NULL,
    -- Byte count of the captured body; 1 MB is the accepted maximum (D008).
    body_size INTEGER NOT NULL CHECK (body_size >= 0 AND body_size <= 1048576),
    -- Complete request as composed at capture time (D049).
    raw_request BYTEA NOT NULL,
    -- IP visible to the backend; NULL when unavailable. Not guaranteed to be
    -- the original sender behind a proxy in v0.1 (D038).
    source_ip TEXT
);

-- Serves the newest-first request list and the retention limit. The id breaks
-- ties so that ordering stays stable when two requests share a timestamp.
CREATE INDEX requests_session_received_at_idx
    ON requests (session_id, received_at DESC, id DESC);
