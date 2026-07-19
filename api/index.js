const express = require('express');
const os = require('os');
const { Pool } = require('pg');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// All connection details come from env vars, not hardcoded values. In
// Compose these are set in docker-compose.yml; in Kubernetes (Phase 3)
// they'll come from a ConfigMap (host/port/db name) and a Secret
// (username/password) instead.
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

// The redis client connects lazily - we call .connect() once at startup
// and reuse the same client for every request instead of reconnecting
// per-request.
const redisClient = createClient({
  url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`,
});

// GET /health - liveness check. Kubernetes will call this later to know if
// the container is alive and should stay in rotation.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET /pod - returns the container's hostname. In plain Docker this is just
// the container ID. In Kubernetes, the hostname equals the Pod name, which
// is how we'll later prove requests are load-balanced across replicas.
app.get('/pod', (req, res) => {
  res.json({
    hostname: os.hostname(),
    version: process.env.VERSION || 'V1',
    timestamp: new Date().toISOString(),
  });
});

// GET /version - identifies which image build is running. Used in Phase 6
// to visibly tell V1 and V2 apart during a rolling update, and to prove
// old/new Pods coexist briefly while the rollout is in progress.
app.get('/version', (req, res) => {
  res.json({ version: process.env.VERSION || 'V1' });
});

// POST /jobs - pushes a job onto a Redis list. The worker pops from the
// same list (see worker/index.js). We use a plain list (LPUSH/BRPOP) since
// this is a learning project - a real system might reach for a proper
// queue library, but a Redis list is enough to demonstrate the pattern.
app.post('/jobs', async (req, res) => {
  const job = { payload: req.body, createdAt: new Date().toISOString() };
  await redisClient.lPush('jobs', JSON.stringify(job));
  res.status(201).json({ status: 'queued', job });
});

// GET /users - list all users from Postgres.
app.get('/users', async (req, res) => {
  const result = await pool.query('SELECT id, name, email, created_at FROM users ORDER BY id');
  res.json(result.rows);
});

// POST /users - insert a user row. No auth, no validation beyond what
// Postgres itself enforces (NOT NULL) - this is a learning project.
app.post('/users', async (req, res) => {
  const { name, email } = req.body;
  const result = await pool.query(
    'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id, name, email, created_at',
    [name, email]
  );
  res.status(201).json(result.rows[0]);
});

async function start() {
  // Connect to Redis before accepting traffic so the first request doesn't
  // race the connection handshake.
  await redisClient.connect();
  app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`);
  });
}

// Only boot the server (and its Redis connection) when this file is run
// directly - e.g. `node index.js` or the Dockerfile's CMD. When the test
// file below does `require('./index.js')` instead, it gets the bare
// Express `app` without triggering a real network connection, which is
// what lets /health and /pod be tested with no Postgres/Redis running.
if (require.main === module) {
  start();
}

module.exports = app;
