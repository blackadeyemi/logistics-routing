const express = require('express');
const cors = require('cors');
const { pool } = require('./db');
const { notFound, errorHandler } = require('./errors');

const app = express();

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/vehicles', require('./routes/vehicles'));
app.use('/drivers', require('./routes/drivers'));
app.use('/orders', require('./routes/orders'));
app.use('/routes', require('./routes/routes'));
app.use('/driver', require('./routes/driver'));
app.use('/stats', require('./routes/stats'));
app.use('/settings', require('./routes/settings'));
app.use('/ai', require('./routes/ai'));
app.use('/ai', require('./routes/copilot'));
app.use('/knowledge', require('./routes/knowledge'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
