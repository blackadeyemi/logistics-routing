"""Optimizer benchmark: Phase 3's exit criterion as a runnable check.

On the seeded manual day (npm run seed -- --reset --manual-day), asks the
optimizer for a plan through the real API several times and checks, from
the stop coordinates and order data alone (not the API's own numbers):

  valid      every order exactly once, its pickup before its dropoff on the
             same route, no vehicle ever above its capacity, every delivery
             window met by the plan's own arrival times
  fast       the whole request under 10 seconds
  shorter    total distance below the manual plan

Distances are recomputed with the haversine formula. Two manual baselines:
  WhatsApp-style  the seeded plan: each driver's pickups first, then the
                  dropoffs (how a day planned on WhatsApp usually runs)
  paired          the same drivers and orders, but each order picked up and
                  delivered in turn, as the planner's "Pair up" button does

Free to run: no LLM calls.
  docker compose exec service-python python -m evals.run_optimizer
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.request
from pathlib import Path

from evals.run_extraction import post

RESULTS = Path(__file__).parent / "results"
API = os.environ.get("EVAL_API_URL", "http://api-node:3000")
RUNS = int(os.environ.get("OPT_RUNS", "3"))


def get(path, token):
    req = urllib.request.Request(f"{API}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read())


def haversine(a, b):
    r = math.radians
    h = math.sin(r(b["lat"] - a["lat"]) / 2) ** 2 + math.cos(r(a["lat"])) * math.cos(r(b["lat"])) * math.sin(r(b["lng"] - a["lng"]) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def path_km(stop_ids, loc):
    return sum(haversine(loc[a], loc[b]) for a, b in zip(stop_ids, stop_ids[1:]))


def check_run(run, orders, drivers, loc, stop_order, stop_type):
    problems = []
    placed = {}
    for r in run["proposed"]:
        cap = drivers[r["driver_id"]]["vehicle"]["capacity_kg"]
        load = 0
        for k, sid in enumerate(r["stop_ids"]):
            o = orders[stop_order[sid]]
            key = (o["id"], stop_type[sid])
            if key in placed:
                problems.append(f"stop {sid} placed twice")
            placed[key] = (r["driver_id"], k)
            load += o["weight_kg"] if stop_type[sid] == "pickup" else -o["weight_kg"]
            if load > cap + 1e-6:
                problems.append(f"{r['driver']} over capacity ({load} kg > {cap} kg)")
            if stop_type[sid] == "dropoff":
                eta = r["stops"][k]["eta"]
                if o["dropoff_after"] and eta < o["dropoff_after"]:
                    problems.append(f"order #{o['id']} delivered at {eta}, before {o['dropoff_after']}")
                if o["dropoff_before"] and eta > o["dropoff_before"]:
                    problems.append(f"order #{o['id']} delivered at {eta}, after {o['dropoff_before']}")
    unassigned = {u["order_id"] for u in run["unassigned"]}
    for oid in orders:
        p, d = placed.get((oid, "pickup")), placed.get((oid, "dropoff"))
        if not p or not d:
            if oid not in unassigned:
                problems.append(f"order #{oid} missing")
        elif p[0] != d[0] or p[1] > d[1]:
            problems.append(f"order #{oid} pickup not before dropoff on one route")
    return problems


def main() -> int:
    status, login = post("/auth/login", {"email": os.environ.get("EVAL_EMAIL", "dispatcher@example.com"),
                                         "password": os.environ.get("EVAL_PASSWORD", "password123")})
    if status != 200:
        print("Login failed", file=sys.stderr)
        return 2
    token = login["token"]
    orders = {o["id"]: o for o in get("/orders?limit=200", token)}
    routes = [get(f"/routes/{r['id']}", token) for r in get("/routes", token)]
    if len(routes) < 2 or any(o["status"] == "pending" for o in orders.values()):
        print("Needs the seeded manual day: docker compose exec api-node npm run seed -- --reset --manual-day", file=sys.stderr)
        return 2
    loc, stop_order, stop_type = {}, {}, {}
    for r in routes:
        for s in r["stops"]:
            loc[s["id"]] = s["location"]
            stop_order[s["id"]] = s["order_id"]
            stop_type[s["id"]] = s["stop_type"]
    drivers = {d["id"]: d for d in get("/drivers", token)}

    whatsapp = [[s["id"] for s in r["stops"]] for r in routes]
    paired = []
    for r in routes:
        seen = []
        for s in r["stops"]:
            if s["order_id"] not in seen:
                seen.append(s["order_id"])
        paired.append([sid for oid in seen for sid in (orders[oid]["pickup_stop_id"], orders[oid]["dropoff_stop_id"])])
    base_whatsapp = sum(path_km(r, loc) for r in whatsapp)
    base_paired = sum(path_km(r, loc) for r in paired)

    runs = []
    for i in range(RUNS):
        started = time.monotonic()
        status, run = post("/optimizations", {}, token)
        secs = time.monotonic() - started
        if status != 201:
            print(f"run {i + 1} failed: {status} {run.get('error')}", file=sys.stderr)
            return 1
        problems = check_run(run, orders, drivers, loc, stop_order, stop_type)
        km = sum(path_km(r["stop_ids"], loc) for r in run["proposed"])
        runs.append({"run_id": run["id"], "secs": round(secs, 2), "solve_ms": run["solve_ms"], "km": round(km, 2),
                     "api_km": run["proposed_km"], "routes": len(run["proposed"]), "unassigned": len(run["unassigned"]),
                     "problems": problems, "stops_per_route": [len(r["stop_ids"]) for r in run["proposed"]]})
        print(f"  run {i + 1}: {km:.1f} km, stops per route {runs[-1]['stops_per_route']}, {secs:.1f} s, {'valid' if not problems else problems}")

    best = min(r["km"] for r in runs)
    worst = max(r["km"] for r in runs)
    slowest = max(r["secs"] for r in runs)
    valid = all(not r["problems"] for r in runs)
    summary = {
        "orders": len(orders), "manual_routes": len(routes), "runs": RUNS,
        "whatsapp_km": round(base_whatsapp, 1), "paired_km": round(base_paired, 1),
        "optimized_km_best": round(best, 1), "optimized_km_worst": round(worst, 1),
        "saving_vs_whatsapp": round(1 - worst / base_whatsapp, 3), "saving_vs_paired": round(1 - worst / base_paired, 3),
        "slowest_secs": slowest, "all_valid": valid,
        "exit_criteria_met": valid and slowest < 10 and worst < base_whatsapp and worst < base_paired,
    }
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "optimizer.json").write_text(json.dumps({"summary": summary, "runs": runs}, indent=2), encoding="utf-8")
    table = "\n".join([
        "| Plan | Total km | Optimized saves |", "| --- | --- | --- |",
        f"| Manual, WhatsApp-style (pickups first) | {summary['whatsapp_km']} | {summary['saving_vs_whatsapp']:.0%} |",
        f"| Manual, each order paired | {summary['paired_km']} | {summary['saving_vs_paired']:.0%} |",
        f"| **Optimized** ({RUNS} runs) | **{summary['optimized_km_best']} to {summary['optimized_km_worst']}** | |",
        "", "| Check | Result |", "| --- | --- |",
        f"| Valid routes (pairs, order, capacity, windows) | {'yes, every run' if valid else 'NO'} |",
        f"| Slowest request | {slowest:.1f} s (limit 10 s) |",
        f"| Beats both manual plans | {'yes' if summary['exit_criteria_met'] else 'NO'} |",
    ])
    (RESULTS / "optimizer-summary.md").write_text(table + "\n", encoding="utf-8")
    print("\n" + table)
    return 0 if summary["exit_criteria_met"] else 1


if __name__ == "__main__":
    sys.exit(main())
