-- Phase 2 additions, part 1: driver notes on stops and AI usage logging.
-- pgvector, knowledge_chunks and agent_actions come in a later file.

-- Directions for the driver at one stop: landmarks, gate codes, "call on
-- arrival", what to collect. Filled from WhatsApp intake or by dispatch.
ALTER TABLE stops ADD COLUMN notes TEXT;

-- One row per LLM request, for cost tracking now and per-tenant billing in
-- Phase 6. Token counts come from the API response.
CREATE TABLE ai_usage (
    id             BIGSERIAL PRIMARY KEY,
    user_id        INT REFERENCES users(id) ON DELETE SET NULL,
    feature        VARCHAR(50)  NOT NULL,
    model          VARCHAR(100) NOT NULL,
    input_tokens   INT NOT NULL DEFAULT 0,
    output_tokens  INT NOT NULL DEFAULT 0,
    cache_read_tokens INT NOT NULL DEFAULT 0,
    duration_ms    INT,
    ok             BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_created ON ai_usage (created_at);
