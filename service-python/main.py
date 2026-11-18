from fastapi import FastAPI

app = FastAPI(title="logistics-service-python")


@app.get("/health")
async def health():
    return {"status": "ok"}


# Phase 2 adds the AI layer here (order extraction, dispatch copilot, RAG).
# Phase 3 adds route optimization with OR-Tools.
# Keep this service internal only, called by api-node, not exposed
# to end users directly.
