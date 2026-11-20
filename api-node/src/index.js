require('dotenv').config();
const http = require('node:http');
const { secret } = require('./auth');
const app = require('./app');
const { attachWebSocket } = require('./realtime');

// Fail at startup, not on the first login, when JWT_SECRET is missing.
secret();

const port = process.env.NODE_PORT || 3000;
const server = http.createServer(app);
attachWebSocket(server);
server.listen(port, () => {
  console.log(`api-node listening on port ${port} (HTTP and WebSocket /ws)`);
});
