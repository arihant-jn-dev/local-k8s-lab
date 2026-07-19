# api/

The Express app. This is the thing users/clients talk to.

## What it does
- `GET /health` - liveness check
- `GET /pod` - returns the container's hostname + a timestamp. Later, in
  Kubernetes, this hostname will equal the Pod name - it's how we'll prove
  requests are load-balanced across multiple replicas.
- `GET /version` - returns the `VERSION` baked into the image (`V1`/`V2`).
  Used in Phase 6 to visibly prove a rolling update actually replaced the
  running code, not just the Pod names.
- `POST /jobs` - pushes a job onto a Redis list (`LPUSH`). The worker blocks
  on the same list (`BRPOP`) and picks it up.
- `GET /users`, `POST /users` - real Postgres CRUD via the `pg` client. No
  auth, no input validation beyond Postgres's own NOT NULL constraints -
  this is a learning project.

All connection details (Postgres host/port/db/user/password, Redis
host/port) come from environment variables - see `docker/docker-compose.yml`
for how they're set today. In Kubernetes (Phase 3) the non-secret values
move to a ConfigMap and the password moves to a Secret.

## How it connects to the rest of the system
- Talks to Redis to enqueue jobs (worker/ picks them up).
- Talks to Postgres directly for user CRUD.
- Gets containerized by `docker/Dockerfile.api`.
- Gets deployed as a Kubernetes Deployment + Service starting Phase 3.
