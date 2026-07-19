# Learning Notes: Local Kubernetes Lab (Structured)

This is a structured, phase-ordered version of `learning.md` — same content,
reorganized for readability.

---

## Phase 1: Docker Basics

**Goal:** build the two images from scratch and prove they work standalone.

```bash
docker build -f docker/Dockerfile.api -t k8s-lab-api:v1 .
docker build -f docker/Dockerfile.worker -t k8s-lab-worker:v1 .
```

### What "building" actually means

Building = following the Dockerfile line by line to produce a
self-contained, runnable filesystem snapshot (the "image"). After
`docker build` finishes, you have `k8s-lab-api:v1` sitting in your local
Docker image cache — a frozen, portable snapshot.

- **`docker build`** → creates the **image** (`k8s-lab-api:v1`) — inert,
  just sitting in Docker's local storage, doing nothing.
- **`docker run`** → takes that image and starts a **container** from it
  — the actual live, running process (Node.js executing `index.js`,
  listening on a port, etc).

So: building means we have an **image** — a template. Running it produces
a **container** — the live thing.

### Why a standalone API container fails

Running just the API container alone (`docker run k8s-lab-api:v1`, no
Redis alongside it) crashes with `getaddrinfo ENOTFOUND redis`. Why:

```js
async function start() {
  await redisClient.connect();   // runs FIRST
  app.listen(PORT, ...);         // runs SECOND, only if the above succeeds
}
```

With no Redis container anywhere near it, there's no DNS entry for the
hostname `redis`. The lookup fails, Node crashes on the unhandled error,
and `app.listen()` on the next line never even runs — so there's no
server listening on port 3000 at all. That's why `curl` said "connection
refused": nothing was listening, not a networking issue on curl's side.

This is why plain `docker run` alone stopped being a valid test for the
API once Phase 2 added real Redis/Postgres wiring — the app is written to
fail fast rather than half-start.

---

## Phase 2: Docker Compose

**Goal:** bring up the full stack (Postgres + Redis + API + worker
together) so the API can actually resolve `redis` as a real hostname.

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

### What this command does

- **`docker compose -f docker/docker-compose.yml`** — use that specific
  compose file (since we're not running from inside `docker/`) to know
  what services exist: `postgres`, `redis`, `api`, `worker`.
- **`up`** — create and start all 4 containers, plus a shared private
  network so they can reach each other by service name (this is exactly
  the network that makes `redis` resolve correctly, unlike the standalone
  test above).
- **`--build`** — rebuild the `api` and `worker` images from their
  Dockerfiles + current source first, instead of reusing a stale image
  (Postgres/Redis are pre-built, so they just get pulled/reused as-is).
- **`-d`** — detached, runs in the background instead of blocking the
  terminal with logs.

Net effect: 4 containers running together on one shared network.

### Verifying it

```bash
docker compose -f docker/docker-compose.yml ps        # check all healthy
curl http://localhost:3000/health
curl http://localhost:3000/pod
curl http://localhost:3000/users
curl -X POST http://localhost:3000/users -H "Content-Type: application/json" -d '{"name":"Ada","email":"ada@example.com"}'
```

**Redis/worker job flow:**

```bash
curl -X POST http://localhost:3000/jobs -H "Content-Type: application/json" -d '{"task":"demo"}'
```

The API immediately responded `"status":"queued"` — it pushed the job onto
Redis and returned right away, without waiting for it to actually be
processed. That's the async decoupling the queue provides.

The worker takes ~5 seconds to "process" it (simulated work) before
writing the result to Postgres.

```bash
docker compose -f docker/docker-compose.yml logs worker --tail=10
docker compose -f docker/docker-compose.yml exec postgres psql -U appuser -d appdb -c "SELECT * FROM jobs;"
```

**Result:** Phase 2 (Docker Compose) is fully verified end-to-end —
Postgres CRUD, and the full Redis→worker→Postgres job pipeline, all
working from a completely clean rebuild.

### Teardown

```bash
docker compose -f docker/docker-compose.yml down
```

(This keeps the `pgdata` volume, so user data would survive a restart —
but we're moving to Kubernetes next, so it doesn't matter either way.)

---

## Phase 3: Kubernetes Core

**Goal:** stand up a local Kubernetes cluster and recreate the same stack
as Deployments/Services/ConfigMaps/Secrets/PV-PVC.

### Starting the cluster

```bash
minikube start --driver=docker
```

**What this does:** creates a brand-new local Kubernetes cluster.

- **`minikube`** — a tool that runs a real, single-node Kubernetes cluster
  locally, so you can learn/test Kubernetes without a real
  multi-machine cluster or cloud account.
- **`start`** — actually creates and boots the cluster (as opposed to
  `stop`, which pauses it, or `delete`, which destroys it).
- **`--driver=docker`** — runs the cluster's "node" as a Docker container
  on your Mac, rather than a full VM (VirtualBox, HyperKit, etc). Since
  Docker Desktop is already running, this is the lightest-weight option.

**Why this is needed at all:** Phase 1-2 only used plain Docker — no
Kubernetes concepts (Pods, Deployments, Services). Kubernetes needs an
actual cluster to talk to — `kubectl apply` does nothing without one.
Minikube gives you that cluster locally, for free.

Running this command:
1. Downloads/reuses a small "base image" that acts as the cluster's node
2. Starts that as a container (visible in `docker ps` as `minikube`)
3. Installs and starts Kubernetes's own internal components inside it
   (API server, scheduler, etc.)
4. Configures local `kubectl` to point at this new cluster automatically

```bash
kubectl get nodes
```

Result: one node called `minikube`, `Ready` status, running Kubernetes
`v1.35.1`.

### Loading images into the cluster

Since the cluster was freshly created (or deleted+recreated), it's
completely empty — no namespaces, no deployments, nothing of ours exists
in it yet. Minikube's node runs its **own separate Docker daemon**,
isolated from the Mac's Docker — so images built on the host need to be
explicitly loaded in.

```bash
minikube image load k8s-lab-api:v1
minikube image load k8s-lab-worker:v1
minikube image load k8s-lab-api:v2   # needed later for Phase 6 rolling updates
```

### Applying manifests, in dependency order

**Where we are:** Minikube gave us an empty cluster; images are loaded in,
but the cluster still has zero knowledge of our app — no namespace, no
deployments. Images sitting in Minikube's Docker daemon don't do anything
by themselves; Kubernetes needs to be told "run a container from this
image" via YAML manifests.

**1. Namespace first** — every other manifest says `namespace:
local-k8s-lab`. If that namespace doesn't exist, those applies would fail.

```bash
kubectl apply -f k8s/00-namespace.yaml
```

**2. ConfigMap** — needs to exist before Postgres/API/worker Deployments,
since they reference it (`configMapKeyRef`) for things like the database
hostname.

```bash
kubectl apply -f k8s/01-configmap.yaml
```

**3. Secret** — same reasoning, holds the Postgres username/password the
Deployments reference (`secretKeyRef`).

```bash
kubectl apply -f k8s/02-secret.yaml
```

**4. Postgres init-SQL ConfigMap** — holds the `CREATE TABLE` statements
for `users`/`jobs`. Must exist before the Postgres Deployment, since it
gets mounted as a file into Postgres's init directory so tables are
created automatically on first boot.

```bash
kubectl apply -f k8s/03-postgres-init-configmap.yaml
```

**5. Postgres storage (PV + PVC)** — must exist before the Postgres
Deployment, since it gets mounted as the data directory. Without real
storage backing it, Postgres's data would live only in the Pod's own
filesystem and vanish the instant the Pod restarts.

```bash
kubectl apply -f k8s/04-postgres-storage.yaml
```

**6. Postgres itself** — now everything it needs exists (Secret, init
ConfigMap, PV/PVC).

```bash
kubectl apply -f k8s/05-postgres.yaml
```

**7. Redis** — simpler, no storage needed (fine to lose in-progress queue
data on a restart for this learning project).

```bash
kubectl apply -f k8s/06-redis.yaml
```

**8. API** — references the ConfigMap/Secret for DB/Redis connection
details, uses the `k8s-lab-api:v2` image already loaded into Minikube.
Also creates a NodePort Service so it's reachable from outside the
cluster later.

```bash
kubectl apply -f k8s/07-api.yaml
```

**9. Worker** — same environment variables, but no Service, since nothing
ever needs to call the worker over the network; it only reaches *out* to
Redis and Postgres.

```bash
kubectl apply -f k8s/08-worker.yaml
```

### Verifying everything came up

Kubernetes has no `depends_on` like Compose does, so the API/worker may
briefly crash-loop while waiting for Postgres/Redis to become ready
before self-healing.

```bash
kubectl get pods -n local-k8s-lab
```

Result: all 8 pods `1/1 Running`, zero restarts (5 API replicas, 1
Postgres, 1 Redis, 1 worker) — matching the manifests exactly.

### Reaching the API from outside the cluster

Since we're on macOS with the Docker driver, we can't reach the cluster's
internal IPs directly from the Mac — need `minikube service` to open a
tunnel.

```bash
minikube service api -n local-k8s-lab --url
```

This prints a `http://127.0.0.1:<port>` URL and needs that terminal to
stay open (run it in a separate tab).

```bash
curl http://127.0.0.1:<port>/health
```

Health check passes through the full chain: curl → Minikube tunnel →
NodePort Service → one of the 5 API Pods → back to you.

```bash
curl http://127.0.0.1:<port>/pod
```

This is the interesting one in Kubernetes: `hostname` now shows an actual
**Pod name** (e.g. `api-7d6c94fb48-htq99`) instead of a random container
ID like plain Docker gave. This is the mechanism Phase 5 (scaling) uses
to prove load-balancing — fire this request many times and, with 5
replicas, different Pod names should answer.

Firing it 5 times in a row showed 3 different Pod names answering,
roughly round-robin — the Service load-balancing across all 5 matching
Pods (a free preview of Phase 5).

### Testing Postgres and the Redis/worker flow through Kubernetes

```bash
curl http://127.0.0.1:<port>/users
curl -X POST http://127.0.0.1:<port>/users -H "Content-Type: application/json" -d '{"name":"Grace Hopper","email":"grace@example.com"}'
curl -X POST http://127.0.0.1:<port>/jobs -H "Content-Type: application/json" -d '{"task":"k8s-fresh-test"}'
```

Job queued — the API Pod pushed it onto the `redis` Service's queue and
returned immediately, same async pattern as Compose.

```bash
kubectl logs -n local-k8s-lab deployment/worker --tail=10
```

Full end-to-end Redis→worker flow confirmed inside Kubernetes: picked up
the job, processed it, wrote the result, logged `Completed` — identical
behavior to Compose, just running as Pods instead of plain containers.

```bash
kubectl exec -n local-k8s-lab deployment/postgres -- psql -U appuser -d appdb -c "SELECT * FROM jobs;"
```

**Result:** Phase 3 (Kubernetes core) fully verified end-to-end, from a
completely clean cluster: all pods healthy, ConfigMap/Secret wiring
works, PV/PVC-backed Postgres works, Redis queue works, worker processing
works — plus a free preview of Phase 5's load-balancing.

**Progress so far:**
- ✅ Phase 1 — Docker basics
- ✅ Phase 2 — Docker Compose
- ✅ Phase 3 — Kubernetes core

---

## Phase 4: Ingress

**What Ingress is:** up to now, the only way to reach the API from
outside the cluster was `minikube service` opening a temporary tunnel to
a raw port number. That's fine for testing, but not how real traffic
reaches a cluster. An **Ingress** is a Kubernetes resource that gives
actual hostname-based routing — "requests for `app.local` go to the `api`
Service" — the way a real production system routes a domain to the right
backend.

**What this phase does:**
1. Enable Minikube's NGINX ingress controller addon (installs the
   controller Pod)
2. Apply `k8s/09-ingress.yaml` (the rule: `app.local` → `api` Service)
3. Add `app.local` to `/etc/hosts` so the Mac treats that fake hostname
   as this cluster
4. Test it — with a known gotcha: on macOS with the Docker driver,
   `minikube tunnel` (the usual advice) doesn't actually help for this
   addon, since it installs as a NodePort Service, not LoadBalancer. Use
   `minikube service` on the ingress controller itself instead.

### Enabling the controller

An Ingress *resource* by itself does nothing — it's just a rule.
Something has to actually read it and act on it: the **Ingress
Controller**.

```bash
minikube addons enable ingress
kubectl get pods -n ingress-nginx   # confirm controller Pod is ready
```

### Applying the Ingress rule

```bash
kubectl apply -f k8s/09-ingress.yaml
kubectl get ingress -n local-k8s-lab   # confirm it registered: app.local, nginx class, port 80
```

### Making it reachable

Need two things: (1) map `app.local` to `127.0.0.1` in `/etc/hosts`, and
(2) a tunnel to actually reach the ingress controller.

```bash
sudo sh -c 'echo "127.0.0.1 app.local" >> /etc/hosts'
```

Since ingress-nginx here runs as a NodePort Service (not LoadBalancer),
`minikube tunnel` won't help — use `minikube service` on the ingress
controller instead:

```bash
minikube service ingress-nginx-controller -n ingress-nginx --url
```

This prints two URLs (port 80 and port 443 mappings). Leave that terminal
open.

### Testing it

Since the tunnel's local port isn't 80, plain `http://app.local` won't
work — send the `app.local` Host header explicitly:

```bash
curl -H "Host: app.local" http://127.0.0.1:<port>/health
```

Confirmed working — request went tunnel → NGINX ingress controller →
matched the `app.local` Host header → routed to the `api` Service → one
of the 5 Pods → `{"status":"ok"}`.

More realistic test using `curl --resolve` (simulates what actually
happens once `/etc/hosts` + a browser are involved):

```bash
curl --resolve app.local:<port>:127.0.0.1 http://app.local:<port>/pod
```

**Result:** Phase 4 (Ingress) fully verified. Two working ways to reach
the API now exist: the direct `minikube service api` tunnel (Phase 3),
and hostname-based Ingress routing (Phase 4).

### Aside: Service types explained

`type` on a Kubernetes Service controls how reachable it is — from where.

- **`ClusterIP`** (default; used by Postgres and Redis) — only reachable
  from *inside* the cluster, by other Pods. Nothing outside can talk to
  it. Exactly right for a database and a queue — never expose those to
  the outside world.
- **`NodePort`** (used by the `api` Service) — opens a specific port on
  the Node itself, reachable from outside the cluster too. That's why the
  API — the thing meant to receive external traffic — uses this, while
  Postgres/Redis don't.
- **`LoadBalancer`** (not used in this project) — normally provisions a
  real cloud load balancer with a public IP. Doesn't really apply locally
  the way it would on AWS/GCP; that's why `minikube tunnel` behaves
  oddly here.

**Why `minikube service` was still needed even with NodePort:** NodePort
should normally be directly reachable at `<node-ip>:<nodeport>`. But on
macOS with the Docker driver, the Mac can't route directly into the
Minikube VM's internal network — so `minikube service` tunnels a local
port on the Mac straight to that NodePort. This is purely a
macOS/Docker-driver quirk, not something inherent to NodePort itself.

**Progress so far:**
- ✅ Phase 1 — Docker basics
- ✅ Phase 2 — Docker Compose
- ✅ Phase 3 — Kubernetes core
- ✅ Phase 4 — Ingress

---

## Phase 5: Scaling

**Current state:** already 5 API replicas running (from
`k8s/07-api.yaml`'s `replicas: 5`).

```bash
kubectl get pods -n local-k8s-lab -l app=api
```

Confirmed 5 replicas, all healthy, no restarts.

### Scaling down

```bash
kubectl scale deployment api --replicas=2 -n local-k8s-lab
```

Watching it live shows Kubernetes picking 2 Pods to keep (`Running`) and
marking the other 3 for teardown (`Terminating`) — the ReplicaSet
reconciling: "desired state says 2, but I have 5" → removes the excess.

```bash
kubectl get pods -n local-k8s-lab -l app=api   # confirm it settles at exactly 2
```

### Proving the Service stopped routing to terminated Pods

```bash
./scripts/hammer-pod.sh http://127.0.0.1:<port> 20
```

Result: 20 requests, only the 2 surviving Pods answered, split roughly
evenly (12/8). No stale routing to the 3 terminated Pods.

### Scaling back up

```bash
kubectl scale deployment api --replicas=5 -n local-k8s-lab
kubectl get pods -n local-k8s-lab -l app=api
```

### Proving new Pods join the rotation automatically

```bash
./scripts/hammer-pod.sh http://127.0.0.1:<port> 50
```

All 5 Pods answered (including the 3 brand-new ones), roughly evenly
distributed — proving new Pods join the load-balancing rotation
automatically the moment they pass readiness, with zero changes needed to
the Service itself.

**Result:** Phase 5 (Scaling) fully verified — both scale-down (traffic
correctly stops reaching terminated Pods) and scale-up (new Pods join
automatically) confirmed with real data.

**Progress so far:**
- ✅ Phase 1 — Docker basics
- ✅ Phase 2 — Docker Compose
- ✅ Phase 3 — Kubernetes core
- ✅ Phase 4 — Ingress
- ✅ Phase 5 — Scaling

---

## Phase 6: Rolling Updates

**Context:** all 5 API Pods are running image `k8s-lab-api:v2` (confirmed
earlier via `/pod` showing `"version":"V2"`). This phase changes that
image while the app stays live — watching Kubernetes replace Pods
gradually (not all at once), and how the `readinessProbe` protects the
rollout if a new version were broken.

Since already on V2, roll **back** to V1 first (a real, observable image
change), then roll forward to V2 again — exercising the mechanism in both
directions.

```bash
grep "image: k8s-lab-api" k8s/07-api.yaml   # confirm current manifest state
```

### Rolling to V1

```bash
kubectl set image deployment/api api=k8s-lab-api:v1 -n local-k8s-lab
kubectl get pods -n local-k8s-lab -l app=api
```

Caught mid-rollout: 5 new Pods (new ReplicaSet hash) already `Running`,
while all 5 old Pods are `Terminating`. The Pod name hash changes because
a new ReplicaSet was created for the new image version, and the old
ReplicaSet is being scaled to zero.

```bash
kubectl get pods -n local-k8s-lab -l app=api   # confirm it settles: 5 new Pods, old ones gone
curl http://127.0.0.1:<port>/version           # confirm V1 is really running, not just Pod names changed
```

### Rolling forward to V2

```bash
kubectl set image deployment/api api=k8s-lab-api:v2 -n local-k8s-lab
```

Interesting detail: the new Pods came back on the **same ReplicaSet hash**
as before V1 — Kubernetes reused it rather than deleting old ReplicaSets,
since it matched the `v2` spec exactly. This is why `kubectl rollout
undo`/history works — old ReplicaSets stick around so rolling back
doesn't require rebuilding anything from scratch.

During the transition you can see the surge/unavailable limits in action:
some old Pods `Terminating`, some new ones `ContainerCreating`
simultaneously, staying within `maxSurge: 1, maxUnavailable: 1` bounds
rather than swapping all 5 Pods at once.

```bash
kubectl get pods -n local-k8s-lab -l app=api   # confirm it settles at 5 Running
curl http://127.0.0.1:<port>/version           # confirm V2 again
```

**Result:** Phase 6 (Rolling updates) fully verified in both directions
(V2→V1 and V1→V2), watching Kubernetes gradually replace Pods each time
while respecting surge/unavailable limits.

**Progress so far:**
- ✅ Phase 1 — Docker basics
- ✅ Phase 2 — Docker Compose
- ✅ Phase 3 — Kubernetes core
- ✅ Phase 4 — Ingress
- ✅ Phase 5 — Scaling
- ✅ Phase 6 — Rolling updates

---

## Phase 7: Redis + Worker Flow End-to-End

**Context:** the basic Redis→worker→Postgres flow already works (proven
in Compose and in this fresh Kubernetes cluster). This phase's real value
is proving something not specifically shown yet: **the worker processes
jobs one at a time, in order**, because there's only 1 worker Pod. Post
several jobs in a quick burst and watch the queue drain sequentially,
~5 seconds apart, rather than all at once.

```bash
kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LLEN jobs   # confirm clean baseline (0)
```

### Posting a burst of jobs

```bash
for i in 1 2 3; do curl -s -X POST http://127.0.0.1:<port>/jobs -H "Content-Type: application/json" -d "{\"task\":\"burst-$i\"}"; echo; done
```

All 3 queued almost instantly (~30ms apart) — the API never waits on
processing.

```bash
kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LLEN jobs   # check queue length right after
kubectl logs -n local-k8s-lab deployment/worker --tail=20               # see processing order
kubectl exec -n local-k8s-lab deployment/postgres -- psql -U appuser -d appdb -c "SELECT id, payload, completed_at FROM jobs ORDER BY id;"
```

**Result:** all 3 jobs processed and completed in the exact order queued
(FIFO). Checking the `completed_at` timestamps in Postgres showed
consecutive jobs landing almost exactly 5.0 seconds apart — matching the
worker's simulated processing sleep precisely. This proves, with real
numbers, that a single worker Pod processes jobs strictly one at a time,
in order — job 2 and job 3 genuinely waited their turn rather than
running concurrently.

**Progress so far:**
- ✅ Phase 1 — Docker basics
- ✅ Phase 2 — Docker Compose
- ✅ Phase 3 — Kubernetes core
- ✅ Phase 4 — Ingress
- ✅ Phase 5 — Scaling
- ✅ Phase 6 — Rolling updates
- ✅ Phase 7 — Redis + worker flow end-to-end

---

## Phase 8: Simulated CD

**Context:** everything so far required a human to manually run
`kubectl apply`/`kubectl scale`/etc. This phase flips that:
`scripts/simulated-cd.sh` runs continuously in the background, polling
the GitHub repo. When it sees a new commit that touches `k8s/`, it
automatically pulls and runs `kubectl apply -f k8s/` — no human running
kubectl at all. This is the core idea behind tools like ArgoCD
("GitOps") — git becomes the source of truth, and something else keeps
the cluster in sync with it.

```bash
git status   # confirm clean, matches GitHub, before starting
```

### Starting the sync loop

Needs to run continuously in its own terminal:

```bash
./scripts/simulated-cd.sh main 15
```

On first run against a fresh checkout, it may do one initial apply (since
it has no prior baseline commit), then settle into steady-state: "No new
commits... nothing to do" every 15 seconds.

### Exercising it: scale down via git push

Edited `k8s/07-api.yaml`: `replicas: 5` → `replicas: 3`.

```bash
git add k8s/07-api.yaml && git commit -m "scale api to 3" && git push origin main
```

Within one poll interval, the sync loop's terminal showed:

```
k8s/ changes detected since last applied commit:
    k8s/07-api.yaml
Pulling latest main...
Applying k8s/ manifests...
...
deployment.apps/api configured
...
Deploy complete.
```

Only `deployment.apps/api configured` changed; everything else showed
`unchanged` — exactly right. No `kubectl` command was typed manually at
all — just a `git push`.

```bash
kubectl get pods -n local-k8s-lab -l app=api   # confirm exactly 3 Pods now
```

### Exercising it: scale back up via git push

Edited `k8s/07-api.yaml` back to `replicas: 5`, committed, pushed the
same way. The sync loop picked it up identically, and the cluster
returned to 5 Pods.

**Result:** Phase 8 (Simulated CD) fully verified with a real
scale-down-to-3 → scale-up-to-5 round trip, both directions triggered
purely by `git push`, with the sync loop performing every `kubectl apply`
automatically.

**Progress so far:**
- ✅ Phase 1 — Docker basics
- ✅ Phase 2 — Docker Compose
- ✅ Phase 3 — Kubernetes core
- ✅ Phase 4 — Ingress
- ✅ Phase 5 — Scaling
- ✅ Phase 6 — Rolling updates
- ✅ Phase 7 — Redis + worker flow end-to-end
- ✅ Phase 8 — Simulated CD

---

## Phase 9: GitHub Actions CI

**Context:** this phase is different from the others — it doesn't run
against the Minikube cluster at all. It runs entirely on GitHub's own
servers, automatically, every time you push.
`.github/workflows/ci.yml` defines two jobs (`api`, `worker`), each
spinning up a fresh Ubuntu VM that checks out the code, installs
dependencies, runs tests (api only), and builds a Docker image — proving
the code is good before anyone thinks about deploying it.

Since commits were already pushed multiple times during Phase 8's
re-tests, CI had already run automatically.

**Verification:** checked
`https://github.com/arihant-jn-dev/local-k8s-lab/actions` — 2 workflow
runs triggered, both green. Confirmed both the `api` and `worker` jobs
passed: checkout → `npm ci` → `npm test` (3 passing tests, api only) →
successful Docker build, for both.

**Result:** Phase 9 (GitHub Actions CI) fully verified.

---

## Final Status: All 9 Phases Verified End-to-End

- ✅ Phase 1 — Docker basics
- ✅ Phase 2 — Docker Compose
- ✅ Phase 3 — Kubernetes core
- ✅ Phase 4 — Ingress
- ✅ Phase 5 — Scaling
- ✅ Phase 6 — Rolling updates
- ✅ Phase 7 — Redis + worker flow end-to-end
- ✅ Phase 8 — Simulated CD
- ✅ Phase 9 — GitHub Actions CI

Every phase was tested with real commands and real evidence, from a
completely clean rebuild — not just "it should work." Along the way, two
genuine gotchas were hit and explained:
1. The standalone-container Redis crash (Phase 1) — a valid lesson about
   the app's fail-fast startup order, not a bug.
2. The NodePort vs. LoadBalancer ingress quirk on macOS with the Docker
   driver (Phase 4) — `minikube tunnel` looks like it should help but
   doesn't for this addon's Service type.
