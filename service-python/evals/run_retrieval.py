"""Retrieval eval: does knowledge search find the right SOP section or
driver note for a dispatcher's question?

Each case lists the sources that answer it: "sop:<document>: <section>" or
"note:<customer>:<pickup|dropoff>". The question goes through the real
search endpoint (api-node, pgvector plus full-text), and we score:

  hit@k     a correct source is among the top k results
  recall@5  share of a case's correct sources found in the top 5
  MRR       mean of 1 / rank of the first correct source

Runs on the seeded data (npm run seed -- --reset) and costs nothing:
embeddings are computed locally.

  docker compose exec service-python python -m evals.run_retrieval
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
from pathlib import Path

from evals.run_extraction import post

HERE = Path(__file__).parent
CASES = HERE / "retrieval_cases.jsonl"
RESULTS = HERE / "results"
API = os.environ.get("EVAL_API_URL", "http://api-node:3000")


def get(path: str, token: str):
    import urllib.request

    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def matches(expected: str, hit: dict) -> bool:
    kind, _, rest = expected.partition(":")
    if kind == "sop":
        return hit["source_type"] == "sop" and hit["title"] == rest
    customer, _, stop_type = rest.rpartition(":")
    return hit["source_type"] == "stop_note" and customer in hit["title"] and f"Driver note, {stop_type} at" in hit["title"]


def main() -> int:
    cases = [json.loads(line) for line in CASES.read_text(encoding="utf-8").splitlines() if line.strip()]
    status, login = post("/auth/login", {"email": os.environ.get("EVAL_EMAIL", "dispatcher@example.com"),
                                         "password": os.environ.get("EVAL_PASSWORD", "password123")})
    if status != 200:
        print(f"Login failed ({status})", file=sys.stderr)
        return 2
    token = login["token"]

    rows = []
    for c in cases:
        hits = get(f"/knowledge/search?{urllib.parse.urlencode({'q': c['question'], 'limit': 5})}", token)
        ranks = []
        for exp in c["expect"]:
            rank = next((i + 1 for i, h in enumerate(hits) if matches(exp, h)), None)
            ranks.append(rank)
        found = [r for r in ranks if r]
        first = min(found) if found else None
        rows.append({"id": c["id"], "question": c["question"], "expect": c["expect"], "ranks": ranks,
                     "top": [h["title"] for h in hits[:3]]})
        mark = "ok  " if first == 1 else ("near" if first else "MISS")
        print(f"  {mark} {c['id']}: ranks {ranks}" + ("" if first == 1 else f"  top: {[h['title'][:60] for h in hits[:2]]}"))

    n = len(rows)

    def hit_at(k):
        return sum(1 for r in rows if any(x and x <= k for x in r["ranks"])) / n

    recall5 = sum(sum(1 for x in r["ranks"] if x) / len(r["ranks"]) for r in rows) / n
    mrr = sum(1 / min(x for x in r["ranks"] if x) if any(r["ranks"]) else 0 for r in rows) / n
    summary = {"cases": n, "hit@1": round(hit_at(1), 3), "hit@3": round(hit_at(3), 3), "hit@5": round(hit_at(5), 3),
               "recall@5": round(recall5, 3), "mrr": round(mrr, 3)}
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "retrieval.json").write_text(json.dumps({"summary": summary, "results": rows}, indent=2, ensure_ascii=False), encoding="utf-8")
    table = "\n".join([
        "| Metric | Score |", "| --- | --- |",
        f"| Hit@1 (right source ranked first) | {summary['hit@1']:.0%} |",
        f"| Hit@3 | {summary['hit@3']:.0%} |",
        f"| Hit@5 | {summary['hit@5']:.0%} |",
        f"| Recall@5 (all right sources in top 5) | {summary['recall@5']:.0%} |",
        f"| MRR | {summary['mrr']:.2f} |",
    ])
    (RESULTS / "retrieval-summary.md").write_text(table + "\n", encoding="utf-8")
    print("\n" + table)
    return 0


if __name__ == "__main__":
    sys.exit(main())
