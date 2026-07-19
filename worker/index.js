const { Pool } = require('pg');
const { createClient } = require('redis');

const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

const redisClient = createClient({
  url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`,
});

// Simulates doing work so we have something visible to watch in the logs
// and something that makes the API/worker asynchrony obvious (the API
// returns immediately after queuing; the result shows up 5s later).
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processJob(rawJob) {
  const job = JSON.parse(rawJob);
  console.log('Processing job...', job);

  await sleep(5000);

  await pool.query(
    'INSERT INTO jobs (payload, status, completed_at) VALUES ($1, $2, NOW())',
    [JSON.stringify(job.payload), 'completed']
  );

  console.log('Completed');
}

async function main() {
  await redisClient.connect();
  console.log('Worker started. Waiting for jobs on the "jobs" Redis list.');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // BRPOP blocks until a job is available instead of polling in a sleep
    // loop - cheaper on Redis and reacts immediately when a job arrives.
    // The 0 means "block forever" (no timeout).
    const result = await redisClient.brPop('jobs', 0);
    await processJob(result.element);
  }
}

main();
