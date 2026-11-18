const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');

const TOKEN_TTL = '12h';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters long');
  }
  return s;
}

// Staff tokens: { sub: user id, role: admin | dispatcher }.
// Driver tokens: { sub: driver id, role: driver }.
function signToken(subject, role) {
  return jwt.sign({ role }, secret(), { subject: String(subject), expiresIn: TOKEN_TTL });
}

// requireAuth('admin', 'dispatcher') allows only those roles.
// With no arguments any valid token is accepted.
function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return next(new HttpError(401, 'Missing bearer token'));
    }
    let payload;
    try {
      payload = jwt.verify(token, secret());
    } catch {
      return next(new HttpError(401, 'Invalid or expired token'));
    }
    if (roles.length && !roles.includes(payload.role)) {
      return next(new HttpError(403, 'Not allowed for this role'));
    }
    req.user = { id: Number(payload.sub), role: payload.role };
    return next();
  };
}

const STAFF = ['admin', 'dispatcher'];

module.exports = { signToken, requireAuth, STAFF, secret };
