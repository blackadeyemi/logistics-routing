// Company SOP documents and knowledge search (SOPs plus driver notes).
const express = require('express');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, idParam } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { indexDocument, reindexAll, search } = require('../knowledge');

const router = express.Router();
router.use(requireAuth(...STAFF));

const doc = z.object({
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(50_000),
}).strict();

const COLUMNS = `d.id, d.title, d.body, d.created_at, d.updated_at, u.full_name AS created_by,
  (SELECT count(*) FROM knowledge_chunks c WHERE c.source_type = 'sop' AND c.source_id = d.id) AS chunks`;

router.get('/documents', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM knowledge_documents d LEFT JOIN users u ON u.id = d.created_by ORDER BY d.title`);
  res.json(rows);
}));

router.get('/documents/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM knowledge_documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [idParam(req)]);
  if (!rows[0]) throw new HttpError(404, 'Document not found');
  res.json(rows[0]);
}));

// SOPs are company policy: admins write them, everyone can read and search.
router.post('/documents', requireAuth('admin'), asyncHandler(async (req, res) => {
  const b = parse(doc, req.body);
  const { rows } = await pool.query(
    'INSERT INTO knowledge_documents (title, body, created_by) VALUES ($1, $2, $3) RETURNING id',
    [b.title, b.body, req.user.id],
  );
  // Indexed before answering, so the editor shows the chunk count.
  await indexDocument(rows[0].id);
  const { rows: out } = await pool.query(`SELECT ${COLUMNS} FROM knowledge_documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [rows[0].id]);
  res.status(201).json(out[0]);
}));

router.put('/documents/:id', requireAuth('admin'), asyncHandler(async (req, res) => {
  const id = idParam(req);
  const b = parse(doc, req.body);
  const { rowCount } = await pool.query('UPDATE knowledge_documents SET title = $2, body = $3, updated_at = now() WHERE id = $1', [id, b.title, b.body]);
  if (!rowCount) throw new HttpError(404, 'Document not found');
  await indexDocument(id);
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM knowledge_documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [id]);
  res.json(rows[0]);
}));

router.delete('/documents/:id', requireAuth('admin'), asyncHandler(async (req, res) => {
  const id = idParam(req);
  const { rowCount } = await pool.query('DELETE FROM knowledge_documents WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Document not found');
  await pool.query("DELETE FROM knowledge_chunks WHERE source_type = 'sop' AND source_id = $1", [id]);
  res.status(204).end();
}));

// GET /knowledge/search?q=gate+code+vgc&limit=5&source=stop_note
router.get('/search', asyncHandler(async (req, res) => {
  const q = parse(z.object({
    q: z.string().trim().min(2).max(500),
    limit: z.coerce.number().int().min(1).max(20).default(5),
    source: z.enum(['sop', 'stop_note']).optional(),
  }), req.query);
  res.json(await search(q.q, { limit: q.limit, sourceType: q.source ?? null }));
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM knowledge_documents) AS documents,
            (SELECT count(*) FROM knowledge_chunks WHERE source_type = 'sop') AS sop_chunks,
            (SELECT count(*) FROM knowledge_chunks WHERE source_type = 'stop_note') AS note_chunks`,
  );
  res.json(rows[0]);
}));

router.post('/reindex', requireAuth('admin'), asyncHandler(async (req, res) => {
  res.json(await reindexAll());
}));

module.exports = router;
