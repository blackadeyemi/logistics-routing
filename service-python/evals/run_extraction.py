"""Extraction eval: WhatsApp messages to draft orders, scored per field.

Runs every case in extraction_cases.jsonl through the real stack
(api-node auth, service-python, Anthropic) and scores each field:

  customer_name   same words, ignoring titles (Mrs, Dr, Baba, Iya...)
  customer_phone  exact +234 number; "INVALID" means it must be flagged
  addresses       every listed key term appears (landmarks, street, area)
  notes           every listed term appears; "any" is not scored
  null            the field must be empty: nothing invented

Usage, from the repo root:
  docker compose exec service-python python -m evals.run_extraction
  docker compose exec service-python python -m evals.run_extraction --model claude-sonnet-5-5 --model claude-opus-5-5

Each run makes one API call per case and costs real money (about $0.005
per case on Sonnet 5.5). Results go to evals/results/.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).parent
CASES = HERE / "extraction_cases.jsonl"
RESULTS = HERE / "results"
API = os.environ.get("EVAL_API_URL", "http://api-node:3000")
FIELDS = ["customer_name", "customer_phone", "pickup_address", "dropoff_address", "pickup_notes", "dropoff_notes"]
TITLES = {"mr", "mrs", "miss", "ms", "dr", "chief", "alhaji", "alhaja", "hajia", "hajiya", "madam", "aunty", "auntie", "uncle", "baba", "mama", "iya", "oga"}
# USD per million tokens (input, output), Anthropic list prices, November 2026.
PRICES = {
    "claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50), "claude-fable-5-2": (8.0, 40.0),
}


def post(path: str, body: dict, token: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower())).strip()


def name_words(text: str) -> set[str]:
    return {w for w in norm(text).split() if w not in TITLES}


def has_term(got: str, term: str) -> bool:
    if term.isdigit() and len(term) >= 7:
        # Phone numbers in notes may be written any way: compare the last 10 digits.
        return term[-10:] in re.sub(r"\D", "", got)
    if term.isdigit():
        return term in re.sub(r"\D", "", got) or term in norm(got)
    return norm(term) in norm(got)


def score_field(field: str, expected, got, phone_valid: bool) -> bool | None:
    if expected == "any":
        return None
    if expected is None:
        return got in (None, "")
    if got in (None, ""):
        return False
    if field == "customer_name":
        return name_words(expected) == name_words(got)
    if field == "customer_phone":
        return (not phone_valid) if expected == "INVALID" else got == expected
    return all(has_term(got, t) for t in expected)


def run_case(case: dict, model: str | None, token: str) -> dict:
    body = {"message": case["message"], **({"model": model} if model else {})}
    started = time.monotonic()
    status, data = post("/ai/extract-order", body, token)
    secs = time.monotonic() - started
    if status != 200:
        return {"id": case["id"], "error": f"{status} {data.get('error')}", "scores": {f: False for f in FIELDS if case["expect"][f] != "any"}, "secs": secs}
    draft = data["draft"]
    scores = {}
    for f in FIELDS:
        s = score_field(f, case["expect"][f], draft.get(f), data.get("phone_valid", False))
        if s is not None:
            scores[f] = s
    return {"id": case["id"], "tags": case.get("tags", []), "scores": scores, "draft": draft, "expect": case["expect"],
            "usage": data.get("usage", {}), "model": data.get("model"), "secs": secs}


def summarise(model: str, results: list[dict]) -> dict:
    per_field = {}
    for f in FIELDS:
        vals = [r["scores"][f] for r in results if f in r["scores"]]
        per_field[f] = {"passed": sum(vals), "total": len(vals)}
    all_scores = [v for r in results for v in r["scores"].values()]
    tin = sum(r.get("usage", {}).get("input_tokens", 0) for r in results)
    tout = sum(r.get("usage", {}).get("output_tokens", 0) for r in results)
    price = PRICES.get(model)
    return {
        "model": model, "cases": len(results),
        "fields_passed": sum(all_scores), "fields_total": len(all_scores),
        "cases_perfect": sum(1 for r in results if all(r["scores"].values())),
        "errors": sum(1 for r in results if "error" in r),
        "per_field": per_field,
        "input_tokens": tin, "output_tokens": tout,
        "cost_usd": round((tin * price[0] + tout * price[1]) / 1e6, 4) if price else None,
        "median_secs": round(sorted(r["secs"] for r in results)[len(results) // 2], 1),
    }


def pct(p: int, t: int) -> str:
    return f"{100 * p / t:.0f}% ({p}/{t})" if t else "n/a"


def markdown(summaries: list[dict]) -> str:
    head = "| Field | " + " | ".join(s["model"] for s in summaries) + " |"
    lines = [head, "|" + " --- |" * (len(summaries) + 1)]
    for f in FIELDS:
        lines.append(f"| {f} | " + " | ".join(pct(s["per_field"][f]["passed"], s["per_field"][f]["total"]) for s in summaries) + " |")
    lines.append("| **All fields** | " + " | ".join(f"**{pct(s['fields_passed'], s['fields_total'])}**" for s in summaries) + " |")
    lines.append("| Cases fully right | " + " | ".join(pct(s["cases_perfect"], s["cases"]) for s in summaries) + " |")
    lines.append("| Median time per message | " + " | ".join(f"{s['median_secs']} s" for s in summaries) + " |")
    lines.append("| Cost of the run | " + " | ".join(f"${s['cost_usd']:.3f}" if s["cost_usd"] is not None else "n/a" for s in summaries) + " |")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", action="append", help="Model to test (repeatable). Default: the model chosen in Settings.")
    ap.add_argument("--only", help="Run only cases whose id contains this text")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    cases = [json.loads(line) for line in CASES.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.only:
        cases = [c for c in cases if args.only in c["id"]]
    status, login = post("/auth/login", {"email": os.environ.get("EVAL_EMAIL", "admin@example.com"),
                                         "password": os.environ.get("EVAL_PASSWORD", "password123")})
    if status != 200:
        print(f"Login failed ({status}): {login.get('error')}. Set EVAL_EMAIL and EVAL_PASSWORD for an admin.", file=sys.stderr)
        return 2
    token = login["token"]

    RESULTS.mkdir(exist_ok=True)
    summaries = []
    for model in args.model or [None]:
        label = model or "settings model"
        print(f"\n== {label}: {len(cases)} cases")
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            results = list(pool.map(lambda c: run_case(c, model, token), cases))
        model_id = model or next((r["model"] for r in results if r.get("model")), "unknown")
        for r in results:
            failed = [f for f, ok in r["scores"].items() if not ok]
            if "error" in r:
                print(f"  ERROR {r['id']}: {r['error']}")
            elif failed:
                print(f"  miss  {r['id']}: " + "; ".join(f"{f} expected {r['expect'][f]!r} got {r['draft'].get(f)!r}" for f in failed))
        s = summarise(model_id, results)
        summaries.append(s)
        # A partial run (--only) never replaces the full results.
        suffix = "-partial" if args.only else ""
        (RESULTS / f"extraction-{model_id}{suffix}.json").write_text(json.dumps({"summary": s, "results": results}, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  {model_id}: {pct(s['fields_passed'], s['fields_total'])} of fields, {s['cases_perfect']}/{s['cases']} cases fully right")

    table = markdown(summaries)
    if not args.only:
        (RESULTS / "extraction-summary.md").write_text(table + "\n", encoding="utf-8")
    print("\n" + table)
    return 0 if all(s["errors"] == 0 for s in summaries) else 1


if __name__ == "__main__":
    sys.exit(main())
