// Real-time updates for the dashboard (Phase 4).
//
// Route handlers call publish() after their transaction commits; every
// signed-in staff browser connected to /ws receives the event. Events:
//   { type: 'location', driver_id, route_id, location, recorded_at, eta }
//   { type: 'stop', route_id, stop_id, order_id, action }
//   { type: 'route', route_id, route_date }      routes planned or changed
//   { type: 'orders' }                           orders created or cancelled
//
// One api-node process holds every connection, so an in-process emitter is
// enough today. Running several api-node instances (Phase 6) would need a
// shared channel such as Postgres LISTEN/NOTIFY behind publish().
const { EventEmitter } = require('node:events');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { secret, STAFF } = require('./auth');

const bus = new EventEmitter();
bus.setMaxListeners(0);

function publish(event) {
  bus.emit('event', { ...event, at: new Date().toISOString() });
}

function subscribe(fn) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}

/**
 * Accepts WebSocket connections on /ws?token=<staff JWT>. The browser
 * cannot set an Authorization header on a WebSocket, so the token travels
 * in the query string, over the same origin as the API.
 */
function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    let payload;
    try {
      payload = jwt.verify(url.searchParams.get('token') || '', secret());
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!STAFF.includes(payload.role)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = { id: Number(payload.sub), role: payload.role };
      // Tokens expire; close the socket when this one does, so a signed-out
      // or expired session stops receiving data.
      const ttl = payload.exp * 1000 - Date.now();
      const expiry = setTimeout(() => ws.close(4001, 'Token expired'), Math.max(ttl, 0));
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      const unsubscribe = subscribe((event) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      });
      ws.on('close', () => {
        clearTimeout(expiry);
        unsubscribe();
      });
      ws.send(JSON.stringify({ type: 'hello', user_id: ws.user.id }));
    });
  });

  // Drop connections that stopped answering (a laptop that went to sleep).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else {
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30_000);
  heartbeat.unref();
  return wss;
}

module.exports = { publish, subscribe, attachWebSocket };
