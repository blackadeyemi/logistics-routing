// Numbers for the dispatcher dashboard: today's workload and the things
// that need someone's attention.
const express = require('express');
const { pool, TODAY_SQL } = require('../db');
const { asyncHandler } = require('../errors');
const { requireAuth, STAFF } = require('../auth');

const router = express.Router();
router.use(requireAuth(...STAFF));

router.get('/today', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    WITH today AS (SELECT ${TODAY_SQL} AS d)
    SELECT
      (SELECT d FROM today)::text AS date,
      (SELECT count(*) FROM orders WHERE status = 'pending') AS pending,
      (SELECT count(*) FROM orders WHERE status = 'assigned') AS assigned,
      (SELECT count(*) FROM orders WHERE status IN ('picked_up', 'en_route')) AS in_transit,
      (SELECT count(*) FROM orders
        WHERE (created_at AT TIME ZONE 'Africa/Lagos')::date = (SELECT d FROM today)) AS created_today,
      (SELECT count(DISTINCT order_id) FROM order_events
        WHERE event_type = 'delivered'
          AND (occurred_at AT TIME ZONE 'Africa/Lagos')::date = (SELECT d FROM today)) AS delivered_today,
      (SELECT count(*) FROM stops s JOIN routes r ON r.id = s.route_id
        WHERE r.route_date = (SELECT d FROM today)
          AND s.stop_type = 'dropoff' AND s.status = 'skipped') AS failed_today,
      (SELECT count(*) FROM routes WHERE route_date = (SELECT d FROM today)) AS routes_today,
      (SELECT count(*) FROM routes
        WHERE route_date = (SELECT d FROM today) AND status = 'in_progress') AS routes_in_progress,
      (SELECT count(*) FROM routes
        WHERE route_date = (SELECT d FROM today) AND status = 'completed') AS routes_completed,
      (SELECT count(*) FROM drivers WHERE status = 'active') AS drivers_active,
      (SELECT count(*) FROM drivers d WHERE d.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM routes r
                        WHERE r.driver_id = d.id AND r.route_date = (SELECT d FROM today))) AS drivers_free,
      (SELECT count(*) FROM drivers WHERE status = 'active' AND pin_hash IS NULL) AS drivers_without_pin
  `);
  res.json(rows[0]);
}));

module.exports = router;
