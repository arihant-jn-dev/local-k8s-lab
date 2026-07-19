# worker/

A standalone Node process (no HTTP server) that blocks on Redis for jobs,
"processes" them (sleep 5s to simulate work), and writes results to Postgres.

## What it does
Uses `BRPOP` (blocking right-pop) on the same Redis list the API `LPUSH`es
onto - this blocks efficiently instead of polling on a timer. When a job
arrives: logs `Processing job...`, sleeps 5s, inserts a row into the `jobs`
table with `status = 'completed'`, then logs `Completed`.

Same env-var driven connection config as `api/` - see
`docker/docker-compose.yml`.

## How it connects to the rest of the system
- Reads jobs that `api/` pushed onto Redis.
- Writes job results into the `jobs` table in Postgres.
- Gets containerized by `docker/Dockerfile.worker`.
- Runs as its own Kubernetes Deployment starting Phase 3 (no Service needed
  since nothing calls it over the network - it only reaches out to Redis
  and Postgres).
