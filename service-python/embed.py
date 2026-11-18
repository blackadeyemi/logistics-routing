"""Local text embeddings for knowledge search.

BAAI/bge-small-en-v1.5 through fastembed (ONNX, CPU). 384 dimensions,
normalised, so cosine similarity is a dot product. Runs inside this service:
no API key, no per-search cost, and notes never leave the server. The model
is baked into the image (see Dockerfile).
"""

from __future__ import annotations

import threading

MODEL_NAME = "BAAI/bge-small-en-v1.5"
DIMENSIONS = 384

_model = None
_lock = threading.Lock()


def model():
    global _model
    with _lock:
        if _model is None:
            from fastembed import TextEmbedding

            _model = TextEmbedding(MODEL_NAME)
    return _model


def embed(texts: list[str], kind: str) -> list[list[float]]:
    """kind is "query" for a search question, "passage" for stored text.
    bge uses a different prefix for each, which improves retrieval."""
    m = model()
    vectors = m.query_embed(texts) if kind == "query" else m.passage_embed(texts)
    return [[round(float(x), 6) for x in v] for v in vectors]
