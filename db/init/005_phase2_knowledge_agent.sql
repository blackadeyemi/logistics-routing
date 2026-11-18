-- Phase 2 additions, part 2: knowledge search (pgvector) and the copilot's
-- audit trail. Needs the custom image in db/Dockerfile.
CREATE EXTENSION IF NOT EXISTS vector;

-- Company SOP documents, written by staff in the dashboard.
CREATE TABLE knowledge_documents (
    id          BIGSERIAL PRIMARY KEY,
    title       VARCHAR(255) NOT NULL,
    body        TEXT NOT NULL,
    created_by  INT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Searchable chunks of SOP documents and stop notes. Embeddings come from
-- service-python (BAAI/bge-small-en-v1.5, 384 dimensions); the tsvector
-- column gives keyword search for hybrid ranking.
CREATE TABLE knowledge_chunks (
    id           BIGSERIAL PRIMARY KEY,
    source_type  VARCHAR(20) NOT NULL CHECK (source_type IN ('sop', 'stop_note')),
    source_id    BIGINT NOT NULL,
    chunk_index  INT NOT NULL DEFAULT 0,
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    embedding    vector(384) NOT NULL,
    tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || content)) STORED,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_type, source_id, chunk_index)
);
CREATE INDEX idx_knowledge_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_knowledge_tsv ON knowledge_chunks USING gin (tsv);

-- Copilot conversations, kept server-side so the model's own content
-- blocks are replayed unchanged on the next turn.
CREATE TABLE agent_conversations (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT,
    messages    JSONB NOT NULL DEFAULT '[]',
    -- What the chat panel shows (text, tool activity, proposals), so a
    -- reload renders the same conversation without parsing model blocks.
    display     JSONB NOT NULL DEFAULT '[]',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_conversations_user ON agent_conversations (user_id, updated_at DESC);

-- Every write the copilot proposes, and what the dispatcher decided. The
-- agent never writes: api-node applies a proposal only on confirmation.
CREATE TABLE agent_actions (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  BIGINT REFERENCES agent_conversations(id) ON DELETE SET NULL,
    user_id          INT REFERENCES users(id) ON DELETE SET NULL,
    prompt           TEXT NOT NULL,
    tool             VARCHAR(50) NOT NULL,
    arguments        JSONB NOT NULL,
    summary          TEXT NOT NULL,
    preview          JSONB,
    status           VARCHAR(20) NOT NULL DEFAULT 'proposed'
                     CHECK (status IN ('proposed', 'confirmed', 'rejected', 'failed')),
    result           JSONB,
    decided_by       INT REFERENCES users(id) ON DELETE SET NULL,
    decided_at       TIMESTAMPTZ,
    -- When the outcome was passed back to the copilot on the next turn.
    reported_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_actions_conversation ON agent_actions (conversation_id);
