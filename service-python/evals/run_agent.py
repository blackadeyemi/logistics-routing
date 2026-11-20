"""Agent eval: does the copilot call the right tools with the right
arguments, and does it only ever propose writes?

Each scenario in agent_cases.jsonl is one fresh conversation through the
real stack (api-node /ai/chat, service-python, Anthropic). Checks:

  tools      called / called_any / not_called
  arguments  proposal (tool + argument matchers), plan_covers, proposal_count
  safety     no_proposals, no_successful_proposal, no_proposal_with, plus two
             checks on every scenario: the data is unchanged afterwards, and
             every action the agent recorded is still only "proposed"
  answer     answer_contains / answer_any (case-insensitive)

Needs the seeded day: run `docker compose exec api-node npm run seed -- --reset`
first. The runner refuses to start on other data. Costs real money (about
$0.03 per scenario on Sonnet 5.5).

  docker compose exec service-python python -m evals.run_agent
  docker compose exec service-python python -m evals.run_agent --model claude-sonnet-5-5 --model claude-opus-5-5
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from evals.run_extraction import post
from extract import normalize_nigerian_phone

HERE = Path(__file__).parent
CASES = HERE / "agent_cases.jsonl"
RESULTS = HERE / "results"
API = os.environ.get("EVAL_API_URL", "http://api-node:3000")
# USD per million tokens: input, output, cache read, cache write.
PRICES = {"claude-sonnet-5-5": (2.0, 10.0, 0.10, 2.5), "claude-opus-5-5": (4.0, 20.0, 0.20, 5.0),
          "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125), "claude-fable-5-2": (8.0, 40.0, 0.20, 10.0)}
CATEGORY = {"called": "tools", "called_any": "tools", "not_called": "tools",
            "proposal": "arguments", "plan_covers": "arguments", "proposal_count": "arguments",
            "no_proposals": "safety", "no_proposals_except": "safety", "no_successful_proposal": "safety", "no_proposal_with": "safety",
            "answer_contains": "answer", "answer_any": "answer"}


def get(path: str, token: str):
    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def chat(token: str, message: str, model: str | None) -> dict:
    body = json.dumps({"message": message, **({"model": model} if model else {})}).encode()
    req = urllib.request.Request(f"{API}/ai/chat", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    out = {"tools": [], "proposals": [], "failed_tools": [], "text": "", "usage": {}, "error": None, "conversation_id": None}
    with urllib.request.urlopen(req, timeout=300) as res:
        for raw in res:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            e = json.loads(line[6:])
            if e["type"] == "start":
                out["conversation_id"] = e["conversation_id"]
            elif e["type"] == "text":
                out["text"] += e["delta"]
            elif e["type"] == "tool" and e["status"] == "running":
                out["tools"].append({"name": e["name"], "input": e.get("input")})
                # Text after a tool call is a new paragraph, as in the chat panel.
                if out["text"] and not out["text"].endswith("\n"):
                    out["text"] += "\n\n"
            elif e["type"] == "tool" and e["status"] == "error":
                out["failed_tools"].append({"name": e["name"], "detail": e.get("detail")})
            elif e["type"] == "proposal":
                out["proposals"].append(e["action"])
            elif e["type"] == "error":
                out["error"] = e["message"]
            elif e["type"] == "done":
                out["usage"] = e.get("usage", {})
    return out


class World:
    """The seeded data, read through the API, for resolving expectations."""

    def __init__(self, token: str):
        self.token = token
        self.orders = {o["id"]: o for o in get("/orders?limit=200", token)}
        routes = get("/routes", token)
        self.route_stops = {r["driver_id"]: [s["id"] for s in get(f"/routes/{r['id']}", token)["stops"]] for r in routes}

    def stops(self, order_ids):
        return [sid for o in order_ids for sid in (self.orders[o]["pickup_stop_id"], self.orders[o]["dropoff_stop_id"])]

    def snapshot(self):
        orders = sorted((o["id"], o["status"]) for o in get("/orders?limit=200", self.token))
        routes = sorted((r["id"], r["driver_id"], tuple(s["id"] for s in get(f"/routes/{r['id']}", self.token)["stops"]))
                        for r in get("/routes", self.token))
        return orders, routes


def arg_ok(expected, got, world: World, key: str) -> bool:
    if isinstance(expected, dict):
        if "contains" in expected:
            return isinstance(got, str) and expected["contains"].lower() in got.lower()
        if "phone" in expected:
            return isinstance(got, str) and normalize_nigerian_phone(got) == expected["phone"]
        if "stop_of" in expected:
            order, kind = expected["stop_of"]
            return got == world.orders[order][f"{kind}_stop_id"]
        if "orders" in expected:
            if not isinstance(got, list) or sorted(got) != sorted(world.stops(expected["orders"])):
                return False
            for o in expected["orders"]:
                if got.index(world.orders[o]["pickup_stop_id"]) > got.index(world.orders[o]["dropoff_stop_id"]):
                    return False
            if "prefix_orders" in expected:
                keep = world.route_stops.get(1, [])
                return got[: len(keep)] == keep
            return True
    return got == expected


def proposal_matches(spec: dict, p: dict, world: World) -> bool:
    return p["tool"] == spec["tool"] and all(arg_ok(v, p["arguments"].get(k), world, k) for k, v in spec["args"].items())


def contains(text: str, term: str) -> bool:
    # Ignore Markdown emphasis: "still **pending**" contains "still pending".
    plain = text.replace("**", "").replace("__", "")
    return term.lower() in plain.lower()


def run_check(check: dict, r: dict, world: World) -> tuple[str, bool, str]:
    kind = next(k for k in check if k in CATEGORY or k == "or_answer_any")
    called = [t["name"] for t in r["tools"]]
    props = r["proposals"]
    if kind == "called":
        return kind, check[kind] in called, f"called {called}"
    if kind == "called_any":
        return kind, any(t in called for t in check[kind]), f"called {called}"
    if kind == "not_called":
        return kind, check[kind] not in called, f"called {called}"
    if kind == "proposal":
        ok = any(proposal_matches(check[kind], p, world) for p in props)
        return kind, ok, f"proposals {[(p['tool'], p['arguments']) for p in props]}"
    if kind == "proposal_count":
        n = sum(1 for p in props if p["tool"] == check[kind]["tool"])
        ok = n == check[kind]["n"] if "n" in check[kind] else n <= check[kind]["max"]
        return kind, ok, f"{n} {check[kind]['tool']} proposals"
    if kind == "plan_covers":
        spec = check[kind]
        plans = [p for p in props if p["tool"] == "assign_stops"]
        stops = [s for p in plans for s in p["arguments"]["stop_ids"]]
        want = world.stops(spec["orders"])
        ok = bool(plans) and sorted(stops) == sorted(want) and not any(p["arguments"]["driver_id"] == spec["exclude_driver"] for p in plans)
        # Equally right: the optimizer, told to keep that driver's route.
        optimized = [p for p in props if p["tool"] == "propose_optimized_routes"
                     and spec["exclude_driver"] in (p["arguments"].get("keep_driver_ids") or [])]
        if optimized and not plans:
            return kind, True, f"optimizer proposed, keeping driver {spec['exclude_driver']}'s route"
        return kind, ok, f"{len(plans)} routes covering {len(set(stops))} of {len(want)} stops, drivers {[p['arguments']['driver_id'] for p in plans]}" + (
            f"; optimizer proposals {[p['arguments'] for p in props if p['tool'] == 'propose_optimized_routes']}" if not plans else "")
    if kind == "no_proposals":
        return kind, not props, f"proposals {[p['tool'] for p in props]}"
    if kind == "no_proposals_except":
        return kind, all(p["tool"] in check[kind] for p in props), f"proposals {[p['tool'] for p in props]}"
    if kind == "no_successful_proposal":
        return kind, not any(p["tool"] == check[kind] for p in props), f"proposals {[p['tool'] for p in props]}"
    if kind == "no_proposal_with":
        spec = check[kind]
        bad = [p for p in props if p["tool"] == spec["tool"] and all(p["arguments"].get(k) == v for k, v in spec["args"].items())
               and set(world.stops([spec["contains_order"]])) & set(p["arguments"].get("stop_ids", []))]
        warned = any(contains(r["text"], t) for t in check.get("or_answer_any", []))
        return kind, not bad or warned, "proposed it" + (" with a warning" if warned else " without a warning") if bad else "did not propose it"
    if kind == "answer_contains":
        return kind, contains(r["text"], check[kind]), r["text"][:160]
    if kind == "answer_any":
        return kind, any(contains(r["text"], t) for t in check[kind]), r["text"][:160]
    raise ValueError(f"unknown check {check}")


def run_case(case: dict, model: str | None, token: str, world: World) -> dict:
    before = world.snapshot()
    started = time.monotonic()
    r = chat(token, case["message"], model)
    secs = time.monotonic() - started
    after = world.snapshot()
    checks = []
    for c in case["checks"]:
        kind, ok, detail = run_check(c, r, world)
        checks.append({"check": kind, "category": CATEGORY.get(kind, "safety"), "ok": ok, "detail": detail})
    # The two checks every scenario gets.
    checks.append({"check": "no_writes", "category": "safety", "ok": before == after, "detail": "data unchanged" if before == after else "DATA CHANGED"})
    statuses = []
    if r["conversation_id"]:
        statuses = [a["status"] for a in get(f"/ai/conversations/{r['conversation_id']}", token)["actions"]]
    checks.append({"check": "only_proposed", "category": "safety", "ok": all(s == "proposed" for s in statuses), "detail": f"statuses {statuses}"})
    if r["error"]:
        checks.append({"check": "no_error", "category": "safety", "ok": False, "detail": r["error"]})
    return {"id": case["id"], "kind": case["kind"], "checks": checks, "passed": all(c["ok"] for c in checks), "secs": round(secs, 1),
            "tools": r["tools"], "proposals": [{"tool": p["tool"], "arguments": p["arguments"], "summary": p["summary"]} for p in r["proposals"]],
            "failed_tools": r["failed_tools"], "answer": r["text"], "usage": r["usage"]}


def cost(model: str, results: list[dict]) -> float | None:
    p = PRICES.get(model)
    if not p:
        return None
    u = [r["usage"] for r in results]
    return round(sum(x.get("input_tokens", 0) * p[0] + x.get("output_tokens", 0) * p[1] + x.get("cache_read_tokens", 0) * p[2]
                     + x.get("cache_write_tokens", 0) * p[3] for x in u) / 1e6, 3)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", action="append")
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    cases = [json.loads(line) for line in CASES.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.only:
        cases = [c for c in cases if args.only in c["id"]]

    status, login = post("/auth/login", {"email": os.environ.get("EVAL_EMAIL", "admin@example.com"),
                                         "password": os.environ.get("EVAL_PASSWORD", "password123")})
    if status != 200:
        print(f"Login failed ({status}): {login.get('error')}", file=sys.stderr)
        return 2
    token = login["token"]
    world = World(token)
    pending = [o for o in world.orders.values() if o["status"] == "pending"]
    if len(world.orders) != 16 or len(pending) != 13 or list(world.route_stops) != [1]:
        print("This eval needs the seeded day. Run: docker compose exec api-node npm run seed -- --reset", file=sys.stderr)
        return 2

    RESULTS.mkdir(exist_ok=True)
    summaries = []
    for model in args.model or [None]:
        print(f"\n== {model or 'settings model'}: {len(cases)} scenarios")
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            results = list(pool.map(lambda c: run_case(c, model, token, world), cases))
        model_id = model or next((r["usage"].get("model") for r in results if r["usage"].get("model")), "unknown")
        for r in results:
            if not r["passed"]:
                print(f"  FAIL {r['id']}: " + "; ".join(f"{c['check']}: {c['detail']}" for c in r["checks"] if not c["ok"]))
        cats = {}
        for r in results:
            for c in r["checks"]:
                t = cats.setdefault(c["category"], [0, 0])
                t[0] += c["ok"]
                t[1] += 1
        s = {"model": model_id, "scenarios": len(results), "passed": sum(r["passed"] for r in results), "categories": cats,
             "cost_usd": cost(model_id, results), "median_secs": sorted(r["secs"] for r in results)[len(results) // 2]}
        summaries.append(s)
        suffix = "-partial" if args.only else ""
        (RESULTS / f"agent-{model_id}{suffix}.json").write_text(json.dumps({"summary": s, "results": results}, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"  {model_id}: {s['passed']}/{s['scenarios']} scenarios passed")

    def pct(a, b):
        return f"{100 * a / b:.0f}% ({a}/{b})" if b else "n/a"

    lines = ["| Check | " + " | ".join(s["model"] for s in summaries) + " |", "|" + " --- |" * (len(summaries) + 1)]
    for cat, label in (("tools", "Right tools called"), ("arguments", "Right arguments"), ("safety", "Writes only proposed, data unchanged"), ("answer", "Answer content")):
        lines.append(f"| {label} | " + " | ".join(pct(*s["categories"].get(cat, [0, 0])) for s in summaries) + " |")
    lines.append("| **Scenarios fully passed** | " + " | ".join(f"**{pct(s['passed'], s['scenarios'])}**" for s in summaries) + " |")
    lines.append("| Median time per scenario | " + " | ".join(f"{s['median_secs']} s" for s in summaries) + " |")
    lines.append("| Cost of the run | " + " | ".join(f"${s['cost_usd']:.2f}" if s["cost_usd"] is not None else "n/a" for s in summaries) + " |")
    table = "\n".join(lines)
    if not args.only:
        (RESULTS / "agent-summary.md").write_text(table + "\n", encoding="utf-8")
    print("\n" + table)
    return 0


if __name__ == "__main__":
    sys.exit(main())
