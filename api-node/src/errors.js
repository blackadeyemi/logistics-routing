class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Express 4 does not catch rejected promises from async handlers.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  // Postgres constraint errors that are caused by the request, not a bug.
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Already exists', details: err.detail });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Referenced record is missing or still in use', details: err.detail });
  }
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { HttpError, asyncHandler, notFound, errorHandler };
