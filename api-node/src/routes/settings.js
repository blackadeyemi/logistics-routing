// App settings an admin manages from the dashboard.
//
// Google Maps: the key is a browser key that ends up in every staff
// browser anyway, so any logged-in staff member can read it (the dashboard
// needs it to draw maps). Only admins can change it. Its protection is the
// HTTP referrer and API restriction set in Google Cloud, not secrecy.
const express = require('express');
const { pool } = require('../db');
const { asyncHandler } = require('../errors');
const { z, parse } = require('../validation');
const { requireAuth, STAFF } = require('../auth');

const router = express.Router();

const KEYS = { mapsKey: 'google_maps_api_key', mapId: 'google_maps_map_id' };

async function readSettings() {
  const { rows } = await pool.query(
    `SELECT s.key, s.value, s.updated_at, u.full_name AS updated_by
     FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by
     WHERE s.key = ANY($1)`,
    [Object.values(KEYS)],
  );
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  const key = by[KEYS.mapsKey];
  return {
    google_maps: {
      api_key: key?.value ?? '',
      map_id: by[KEYS.mapId]?.value ?? '',
      updated_at: key?.updated_at ?? null,
      updated_by: key?.updated_by ?? null,
    },
  };
}

router.get('/', requireAuth(...STAFF), asyncHandler(async (req, res) => {
  res.json(await readSettings());
}));

// Empty string clears a value. Google keys are about 39 characters of
// letters, digits, dash and underscore; map IDs are hex-like.
const updateSettings = z.object({
  google_maps: z.object({
    api_key: z.string().trim().max(200)
      .refine((v) => v === '' || /^[A-Za-z0-9_-]{20,200}$/.test(v), 'Does not look like a Google API key')
      .optional(),
    map_id: z.string().trim().max(100)
      .refine((v) => v === '' || /^[A-Za-z0-9_-]+$/.test(v), 'Letters, digits, dashes and underscores only')
      .optional(),
  }).strict(),
}).strict();

router.put('/', requireAuth('admin'), asyncHandler(async (req, res) => {
  const { google_maps: gm } = parse(updateSettings, req.body);
  const changes = [[KEYS.mapsKey, gm.api_key], [KEYS.mapId, gm.map_id]].filter(([, v]) => v !== undefined);
  for (const [key, value] of changes) {
    if (value === '') {
      await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
    } else {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, value, req.user.id],
      );
    }
  }
  res.json(await readSettings());
}));

module.exports = router;
