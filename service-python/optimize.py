"""Route optimization with OR-Tools: a pickup and delivery vehicle routing
problem with capacities and optional delivery time windows.

Stateless like the rest of this service: api-node sends the stops of the
day, the drivers and their vehicles, and a distance and duration matrix
between stops (straight lines from PostGIS today, roads in Phase 5), and
gets routes back. Nothing is saved here.

Model:
- One node per stop, plus a dummy depot at distance 0 from everything, so
  routes are open: a driver starts at their first pickup and ends at their
  last dropoff, which is how the manual plan is measured too.
- Arc cost is distance. Each order's pickup and dropoff go on the same
  vehicle, pickup first.
- Capacity in kg: +weight at the pickup, -weight at the dropoff.
- Time: travel time from the matrix plus a fixed service time at each stop,
  within the working day; dropoffs with a window must be reached inside it.
- An order that cannot be served (too heavy for every vehicle, impossible
  window) is dropped at a large penalty and reported, rather than making
  the whole plan infeasible.
"""

from __future__ import annotations

import time

from ortools.constraint_solver import pywrapcp, routing_enums_pb2
from pydantic import BaseModel, Field

DROP_PENALTY = 10_000_000  # metres: far more than any route, so drops are a last resort
KG_SCALE = 100  # capacities in units of 10 g, since OR-Tools wants integers


class Vehicle(BaseModel):
    driver_id: int
    capacity_kg: float = Field(gt=0)


class Order(BaseModel):
    order_id: int
    pickup: int  # index into the matrices
    dropoff: int
    weight_kg: float = Field(gt=0)
    dropoff_after_min: int | None = None  # minutes after midnight
    dropoff_before_min: int | None = None


class OptimizeRequest(BaseModel):
    vehicles: list[Vehicle] = Field(min_length=1, max_length=50)
    orders: list[Order] = Field(min_length=1, max_length=400)
    distances_m: list[list[int]]
    durations_s: list[list[int]]
    service_min: int = 5
    day_start_min: int = 8 * 60
    day_end_min: int = 20 * 60
    time_limit_s: float = Field(default=5.0, gt=0, le=30)
    # Cost of a route's working time (first stop to last, waiting included),
    # in metres per second. Distance alone lets a driver idle for hours
    # waiting for a late window with other parcels on board; this puts a
    # price on that. 1 m/s means an hour of route time weighs like 3.6 km.
    time_cost_m_per_s: int = Field(default=0, ge=0, le=100)
    # Cost of each delivery's lateness: every second a dropoff happens after
    # the earliest it could (day start, or its window opening), in metres.
    # Customers get parcels earlier, and a late window no longer holds back
    # everything else on the same vehicle.
    late_cost_m_per_s: int = Field(default=1, ge=0, le=100)


def solve(req: OptimizeRequest) -> dict:
    started = time.monotonic()
    n = len(req.distances_m)
    if any(len(row) != n for row in req.distances_m) or len(req.durations_s) != n:
        raise ValueError("matrices must be square and the same size")
    for o in req.orders:
        if not (0 <= o.pickup < n and 0 <= o.dropoff < n):
            raise ValueError(f"order {o.order_id} points outside the matrix")

    # Node 0 is the depot; stop i is node i + 1.
    manager = pywrapcp.RoutingIndexManager(n + 1, len(req.vehicles), 0)
    routing = pywrapcp.RoutingModel(manager)

    def node(index: int) -> int:
        return manager.IndexToNode(index)

    def dist(i: int, j: int) -> int:
        a, b = node(i), node(j)
        return 0 if a == 0 or b == 0 else req.distances_m[a - 1][b - 1]

    dist_cb = routing.RegisterTransitCallback(dist)
    routing.SetArcCostEvaluatorOfAllVehicles(dist_cb)

    service_s = req.service_min * 60

    def travel(i: int, j: int) -> int:
        a, b = node(i), node(j)
        if a == 0:
            return 0
        stay = service_s
        return stay if b == 0 else req.durations_s[a - 1][b - 1] + stay

    time_cb = routing.RegisterTransitCallback(travel)
    day_start, day_end = req.day_start_min * 60, req.day_end_min * 60
    # Waiting is allowed (slack), for example until a window opens.
    routing.AddDimension(time_cb, day_end, day_end, False, "time")
    time_dim = routing.GetDimensionOrDie("time")
    for v in range(len(req.vehicles)):
        time_dim.CumulVar(routing.Start(v)).SetRange(day_start, day_end)
        time_dim.CumulVar(routing.End(v)).SetRange(day_start, day_end)
        # Start each driver as early as the plan allows.
        routing.AddVariableMinimizedByFinalizer(time_dim.CumulVar(routing.Start(v)))
    if req.time_cost_m_per_s:
        time_dim.SetSpanCostCoefficientForAllVehicles(req.time_cost_m_per_s)

    demand = [0] * (n + 1)
    for o in req.orders:
        w = round(o.weight_kg * KG_SCALE)
        demand[o.pickup + 1] += w
        demand[o.dropoff + 1] -= w

    def load(i: int) -> int:
        return demand[node(i)]

    load_cb = routing.RegisterUnaryTransitCallback(load)
    routing.AddDimensionWithVehicleCapacity(load_cb, 0, [round(v.capacity_kg * KG_SCALE) for v in req.vehicles], True, "load")

    solver = routing.solver()
    for o in req.orders:
        p, d = manager.NodeToIndex(o.pickup + 1), manager.NodeToIndex(o.dropoff + 1)
        routing.AddPickupAndDelivery(p, d)
        solver.Add(routing.VehicleVar(p) == routing.VehicleVar(d))
        solver.Add(time_dim.CumulVar(p) <= time_dim.CumulVar(d))
        lo = max(day_start, (o.dropoff_after_min or 0) * 60)
        hi = min(day_end, o.dropoff_before_min * 60 if o.dropoff_before_min is not None else day_end)
        time_dim.CumulVar(d).SetRange(min(lo, hi), hi)
        if req.late_cost_m_per_s:
            time_dim.SetCumulVarSoftUpperBound(d, min(lo, hi), req.late_cost_m_per_s)
        routing.AddDisjunction([p], DROP_PENALTY)
        routing.AddDisjunction([d], DROP_PENALTY)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromMilliseconds(int(req.time_limit_s * 1000))

    solution = routing.SolveWithParameters(params)
    solve_ms = int((time.monotonic() - started) * 1000)
    if solution is None:
        return {"status": "no_solution", "routes": [], "unassigned": [o.order_id for o in req.orders], "solve_ms": solve_ms}

    routes = []
    served: set[int] = set()
    stop_to_order = {}
    for o in req.orders:
        stop_to_order[o.pickup] = o.order_id
        stop_to_order[o.dropoff] = o.order_id
    for v, vehicle in enumerate(req.vehicles):
        idx = routing.Start(v)
        stops, arrivals, peak, distance = [], [], 0, 0
        prev = None
        while not routing.IsEnd(idx):
            nd = node(idx)
            if nd != 0:
                stops.append(nd - 1)
                arrivals.append(solution.Value(time_dim.CumulVar(idx)) // 60)
                peak = max(peak, solution.Value(routing.GetDimensionOrDie("load").CumulVar(idx)) + demand[nd])
                if prev is not None:
                    distance += req.distances_m[prev][nd - 1]
                prev = nd - 1
            idx = solution.Value(routing.NextVar(idx))
        if stops:
            served.update(stop_to_order[s] for s in stops)
            routes.append({"driver_id": vehicle.driver_id, "stops": stops, "arrival_min": arrivals,
                           "distance_m": distance, "peak_load_kg": round(peak / KG_SCALE, 2)})
    unassigned = [o.order_id for o in req.orders if o.order_id not in served]
    return {"status": "ok", "routes": routes, "unassigned": unassigned, "solve_ms": solve_ms,
            "total_distance_m": sum(r["distance_m"] for r in routes)}
