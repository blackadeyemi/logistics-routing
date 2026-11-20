// Dispatch copilot: chat, conversations, and the proposals it makes.
//
// Flow of one turn: the browser posts a message here; api-node loads the
// conversation, tells the model what happened to its earlier proposals,
// and streams a turn from service-python back as server-sent events.
// service-python calls api-node with this user's own token for every tool,
// so the agent can never do more than the logged-in user. Write tools only
// create a proposal (POST /ai/actions); the dispatcher confirms or rejects
// it, and only a confirmation applies it.
const express = require('express');
const { pool, TODAY_SQL } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, id, idParam } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { serviceUrl, requireConfig, logUsage } = require('../ai');
const { proposeAction, applyAction, WRITE_TOOLS } = require('../agentActions');

const router = express.Router();
router.use(requireAuth(...STAFF));

const ACTION_COLUMNS = 'id, conversation_id, tool, arguments, summary, preview, status, result, created_at, decided_at';

async function ownConversation(conversationId, user) {
  const { rows } = await pool.query('SELECT * FROM agent_conversations WHERE id = $1', [conversationId]);
  if (!rows[0] || (rows[0].user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Conversation not found');
  return rows[0];
}

router.get('/conversations', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, created_at, updated_at FROM agent_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20',
    [req.user.id],
  );
  res.json(rows);
}));

router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const conv = await ownConversation(idParam(req), req.user);
  const { rows: actions } = await pool.query(`SELECT ${ACTION_COLUMNS} FROM agent_actions WHERE conversation_id = $1 ORDER BY id`, [conv.id]);
  res.json({ id: conv.id, title: conv.title, display: conv.display, actions, updated_at: conv.updated_at });
}));

// Called by service-python, with the user's token, when the model uses a
// write tool. Only the proposal is recorded; nothing else changes.
router.post('/actions', asyncHandler(async (req, res) => {
  const b = parse(z.object({
    conversation_id: id,
    prompt: z.string().max(4000),
    tool: z.enum(WRITE_TOOLS),
    arguments: z.record(z.any()),
  }).strict(), req.body);
  await ownConversation(b.conversation_id, req.user);
  const p = await proposeAction(b.tool, b.arguments, { userId: req.user.id });
  const { rows } = await pool.query(
    `INSERT INTO agent_actions (conversation_id, user_id, prompt, tool, arguments, summary, preview)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ACTION_COLUMNS}`,
    [b.conversation_id, req.user.id, b.prompt, b.tool, p.arguments, p.summary, p.preview],
  );
  res.status(201).json(rows[0]);
}));

async function decidable(req) {
  const { rows } = await pool.query(
    'SELECT a.*, c.user_id AS owner FROM agent_actions a LEFT JOIN agent_conversations c ON c.id = a.conversation_id WHERE a.id = $1',
    [idParam(req)],
  );
  const a = rows[0];
  if (!a || (a.owner !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Action not found');
  if (a.status !== 'proposed') throw new HttpError(409, `This action was already ${a.status}`);
  return a;
}

// The dispatcher confirms: apply it through the public API as this user.
router.post('/actions/:id/confirm', asyncHandler(async (req, res) => {
  const a = await decidable(req);
  // Claim it first, so a double click cannot apply it twice.
  const { rowCount } = await pool.query(
    "UPDATE agent_actions SET status = 'confirmed', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'proposed'",
    [a.id, req.user.id],
  );
  if (!rowCount) throw new HttpError(409, 'This action was already decided');
  let status = 'confirmed';
  let result;
  try {
    result = await applyAction(a.tool, a.arguments, req.headers.authorization);
  } catch (err) {
    status = 'failed';
    result = { error: err.message };
  }
  const { rows } = await pool.query(`UPDATE agent_actions SET status = $2, result = $3 WHERE id = $1 RETURNING ${ACTION_COLUMNS}`, [a.id, status, result]);
  res.json(rows[0]);
}));

router.post('/actions/:id/reject', asyncHandler(async (req, res) => {
  const a = await decidable(req);
  const { rows } = await pool.query(
    `UPDATE agent_actions SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1 RETURNING ${ACTION_COLUMNS}`,
    [a.id, req.user.id],
  );
  res.json(rows[0]);
}));

// What happened to the copilot's proposals since its last turn, told to it
// at the start of the next one so it never assumes a proposal was applied.
async function proposalStatus(conversationId) {
  const { rows } = await pool.query(
    `SELECT id, tool, summary, status, result FROM agent_actions
     WHERE conversation_id = $1 AND (status = 'proposed' OR reported_at IS NULL)
     ORDER BY id`,
    [conversationId],
  );
  if (!rows.length) return { text: null, ids: [] };
  const lines = rows.map((a) => {
    if (a.status === 'proposed') return `- Action #${a.id} (${a.tool}) is still waiting for the dispatcher: ${a.summary}`;
    if (a.status === 'confirmed') return `- Action #${a.id} (${a.tool}) was confirmed and applied: ${a.result?.message ?? 'done'}`;
    if (a.status === 'failed') return `- Action #${a.id} (${a.tool}) was confirmed but failed: ${a.result?.error}`;
    return `- Action #${a.id} (${a.tool}) was rejected by the dispatcher and not applied.`;
  });
  return {
    text: `[Status of your proposals]\n${lines.join('\n')}`,
    ids: rows.filter((a) => a.status !== 'proposed').map((a) => a.id),
  };
}

// POST /ai/chat { conversation_id?, message } answers with an event stream:
// start, text, tool, proposal, sources, error, done.
router.post('/chat', asyncHandler(async (req, res) => {
  const b = parse(z.object({
    conversation_id: id.optional(),
    message: z.string().trim().min(1).max(4000),
    // Admins can pick the model for a turn, which is how the agent eval
    // compares models. Everyone else gets the model chosen in Settings.
    model: z.string().regex(/^claude-[a-z0-9.-]+$/).optional(),
  }).strict(), req.body);
  if (b.model && req.user.role !== 'admin') throw new HttpError(403, 'Only admins can choose the model per request');
  const cfg = await requireConfig();
  if (b.model) cfg.model = b.model;
  let conv;
  if (b.conversation_id) {
    conv = await ownConversation(b.conversation_id, req.user);
  } else {
    const { rows } = await pool.query(
      'INSERT INTO agent_conversations (user_id, title) VALUES ($1, $2) RETURNING *',
      [req.user.id, b.message.slice(0, 80)],
    );
    conv = rows[0];
  }
  const status = await proposalStatus(conv.id);
  const content = [...(status.text ? [{ type: 'text', text: status.text }] : []), { type: 'text', text: b.message }];
  const messages = [...conv.messages, { role: 'user', content }];
  const { rows: me } = await pool.query(`SELECT full_name, (${TODAY_SQL})::text AS today FROM users WHERE id = $1`, [req.user.id]);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: 'start', conversation_id: conv.id });

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let done = null;
  try {
    const upstream = await fetch(`${serviceUrl()}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anthropic-Api-Key': cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        conversation_id: conv.id,
        prompt: b.message,
        user_token: (req.headers.authorization || '').replace(/^Bearer /, ''),
        user: { name: me[0]?.full_name ?? 'Dispatcher', role: req.user.role },
        today: me[0]?.today,
        // Citation refs (S1, S2...) continue across the conversation.
        ref_offset: conv.display.filter((d) => d.type === 'sources').reduce((n, d) => n + d.items.length, 0),
      }),
      signal: abort.signal,
    });
    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      throw new HttpError(upstream.status, err.detail?.message ?? 'The copilot failed');
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i = buf.indexOf('\n\n');
      while (i >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        i = buf.indexOf('\n\n');
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        // The final event carries the turn's model messages: those stay on
        // the server, the browser gets only what it renders.
        if (event.type === 'done') done = event;
        else send(event);
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      send({ type: 'error', message: err instanceof HttpError ? err.message : 'The copilot stopped unexpectedly. Try again.' });
    }
  }

  if (done) {
    await pool.query(
      'UPDATE agent_conversations SET messages = $2, display = display || $3::jsonb, updated_at = now() WHERE id = $1',
      [conv.id, JSON.stringify([...messages, ...done.messages]), JSON.stringify([{ type: 'user', text: b.message }, ...done.display])],
    );
    if (status.ids.length) await pool.query('UPDATE agent_actions SET reported_at = now() WHERE id = ANY($1)', [status.ids]);
    await logUsage(req.user.id, 'copilot', cfg.model, done.usage, true);
    send({ type: 'done', conversation_id: conv.id, usage: done.usage });
  } else if (!abort.signal.aborted) {
    await logUsage(req.user.id, 'copilot', cfg.model, null, false);
  }
  res.end();
}));

module.exports = router;
