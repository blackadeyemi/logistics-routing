// Knowledge search over company SOPs and driver notes on stops.
//
// Text is embedded by service-python (local model, no API key) and stored
// in knowledge_chunks with pgvector. Search is hybrid: vector similarity
// and Postgres full-text ranking, merged with reciprocal rank fusion, so an
// exact gate code or street name and a loosely worded question both work.
const { pool } = require('./db');
const { HttpError } = require('./errors');

const serviceUrl = () => (process.env.PYTHON_SERVICE_URL || 'http://service-python:8000').replace(/\/$/, '');

async function embed(texts, kind) {
  let res;
  try {
    res = await fetch(`${serviceUrl()}/ai/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, kind }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HttpError(503, 'The AI service is not reachable, so knowledge search is unavailable');
  }
  if (!res.ok) throw new HttpError(502, 'Embedding failed');
  return (await res.json()).vectors;
}

const vec = (v) => `[${v.join(',')}]`;

/**
 * Split an SOP into chunks of about 900 characters, keeping each section
 * heading with its text so a chunk makes sense on its own when cited.
 */
function chunkDocument(title, body) {
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^#{1,4}\s+(.+)/.exec(line);
    if (h) {
      if (current.lines.join('').trim()) sections.push(current);
      current = { heading: h[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.join('').trim()) sections.push(current);

  const chunks = [];
  for (const s of sections) {
    const paragraphs = s.lines.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let buf = '';
    const flush = () => {
      if (buf.trim()) chunks.push({ title: s.heading ? `${title}: ${s.heading}` : title, content: buf.trim() });
      buf = '';
    };
    for (const p of paragraphs) {
      if (buf && buf.length + p.length > 900) flush();
      buf += (buf ? '\n\n' : '') + p;
    }
    flush();
  }
  return chunks;
}

async function replaceChunks(db, sourceType, sourceId, chunks) {
  await db.query('DELETE FROM knowledge_chunks WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId]);
  if (!chunks.length) return 0;
  const vectors = await embed(chunks.map((c) => `${c.title}\n${c.content}`), 'passage');
  for (let i = 0; i < chunks.length; i += 1) {
    await db.query(
      `INSERT INTO knowledge_chunks (source_type, source_id, chunk_index, title, content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [sourceType, sourceId, i, chunks[i].title, chunks[i].content, vec(vectors[i])],
    );
  }
  return chunks.length;
}

async function indexDocument(docId, db = pool) {
  const { rows } = await db.query('SELECT id, title, body FROM knowledge_documents WHERE id = $1', [docId]);
  if (!rows[0]) return replaceChunks(db, 'sop', docId, []);
  return replaceChunks(db, 'sop', docId, chunkDocument(rows[0].title, rows[0].body));
}

// A stop note becomes one chunk that says where it applies, so "gate code
// for the VGC house" finds it through the address as well as the note.
async function indexStopNotes(orderId, db = pool) {
  const { rows } = await db.query(
    `SELECT s.id, s.stop_type, s.address, s.notes, o.customer_name, o.id AS order_id
     FROM stops s JOIN orders o ON o.id = s.order_id WHERE s.order_id = $1`,
    [orderId],
  );
  let n = 0;
  for (const s of rows) {
    const chunks = s.notes
      ? [{ title: `Driver note, ${s.stop_type} at ${s.address} (order #${s.order_id}, ${s.customer_name})`, content: s.notes }]
      : [];
    n += await replaceChunks(db, 'stop_note', s.id, chunks);
  }
  return n;
}

// Index after the request has been answered: search being briefly behind
// is fine, an order failing to save because the AI service is down is not.
function indexLater(fn, ...args) {
  setImmediate(() => {
    fn(...args).catch((err) => console.warn(`knowledge indexing failed: ${err.message}`));
  });
}

async function reindexAll() {
  await pool.query('DELETE FROM knowledge_chunks');
  const { rows: docs } = await pool.query('SELECT id FROM knowledge_documents ORDER BY id');
  const { rows: orders } = await pool.query('SELECT DISTINCT order_id FROM stops WHERE notes IS NOT NULL ORDER BY order_id');
  let chunks = 0;
  for (const d of docs) chunks += await indexDocument(d.id);
  for (const o of orders) chunks += await indexStopNotes(o.order_id);
  return { documents: docs.length, orders_with_notes: orders.length, chunks };
}

/**
 * Hybrid search. Returns chunks with where they came from, for citations.
 * sourceType limits to 'sop' or 'stop_note'.
 */
async function search(query, { limit = 5, sourceType = null } = {}) {
  const [qv] = await embed([query], 'query');
  // OR the words for keyword search: a question rarely contains every word
  // of the passage that answers it.
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1).slice(0, 20);
  const tsq = words.join(' | ') || 'zzzznomatch';
  const { rows } = await pool.query(
    `WITH v AS (
       SELECT id, row_number() OVER (ORDER BY embedding <=> $1::vector) AS r, 1 - (embedding <=> $1::vector) AS sim
       FROM knowledge_chunks
       WHERE ($4::text IS NULL OR source_type = $4)
       ORDER BY embedding <=> $1::vector LIMIT 30
     ), k AS (
       SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS r
       FROM knowledge_chunks c, to_tsquery('english', $2) q
       WHERE c.tsv @@ q AND ($4::text IS NULL OR c.source_type = $4)
       ORDER BY ts_rank_cd(c.tsv, q) DESC LIMIT 30
     )
     SELECT c.id, c.source_type, c.source_id, c.chunk_index, c.title, c.content,
            round(COALESCE(v.sim, 0)::numeric, 3) AS similarity,
            COALESCE(1.0 / (60 + v.r), 0) + COALESCE(1.0 / (60 + k.r), 0) AS score,
            CASE WHEN c.source_type = 'stop_note' THEN s.order_id END AS order_id
     FROM knowledge_chunks c
     LEFT JOIN v ON v.id = c.id
     LEFT JOIN k ON k.id = c.id
     LEFT JOIN stops s ON c.source_type = 'stop_note' AND s.id = c.source_id
     WHERE v.id IS NOT NULL OR k.id IS NOT NULL
     ORDER BY score DESC, similarity DESC
     LIMIT $3`,
    [vec(qv), tsq, limit, sourceType],
  );
  return rows.map(({ score, ...r }) => ({ ...r, score: Number(Number(score).toFixed(5)) }));
}

module.exports = { chunkDocument, indexDocument, indexStopNotes, indexLater, reindexAll, search, embed };
