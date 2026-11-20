// Route optimization runs: propose a plan for a day, compare it with the
// manual plan, then accept or discard it. See src/optimizer.js.
const express = require('express');
const { pool } = require('../db');
const { asyncHandler } = require('../errors');
const { z, parse, id, idParam, isoDate } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { staffActor } = require('../events');
const { optimizeDay, acceptRun, discardRun, getRun } = require('../optimizer');

const router = express.Router();
router.use(requireAuth(...STAFF));

// POST /optimizations { route_date?, keep_driver_ids? } : runs the optimizer
// (about 5 s) and stores the proposal. Changes no routes. Drivers listed in
// keep_driver_ids keep their current route, and its orders stay on it.
router.post('/', asyncHandler(async (req, res) => {
  const b = parse(z.object({ route_date: isoDate.optional(), keep_driver_ids: z.array(id).max(50).optional() }).strict(), req.body ?? {});
  res.status(201).json(await optimizeDay(b.route_date, req.user.id, { keepDriverIds: b.keep_driver_ids ?? [] }));
}));

router.get('/', asyncHandler(async (req, res) => {
  const q = parse(z.object({ date: isoDate.optional() }), req.query);
  const { rows } = await pool.query(
    `SELECT id, route_date::text AS route_date, manual_km, proposed_km, solve_ms, status, created_at
     FROM optimization_runs WHERE ($1::date IS NULL OR route_date = $1) ORDER BY created_at DESC LIMIT 20`,
    [q.date ?? null],
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await getRun(idParam(req)));
}));

router.post('/:id/accept', asyncHandler(async (req, res) => {
  res.json(await acceptRun(idParam(req), req.user.id, staffActor(req)));
}));

router.post('/:id/discard', asyncHandler(async (req, res) => {
  res.json(await discardRun(idParam(req), req.user.id));
}));

module.exports = router;
