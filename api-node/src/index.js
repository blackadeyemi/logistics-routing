require('dotenv').config();
const { secret } = require('./auth');
const app = require('./app');

// Fail at startup, not on the first login, when JWT_SECRET is missing.
secret();

const port = process.env.NODE_PORT || 3000;
app.listen(port, () => {
  console.log(`api-node listening on port ${port}`);
});
