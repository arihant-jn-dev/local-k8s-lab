# local-k8s-lab

A learning project for Docker, Kubernetes, and CI/CD - built entirely local,
no real registry, no real cluster, no auth/TLS. See
`k8s-learning-project-prompt.md` for the full build spec and phase plan.

## Layout
- `api/` - Express app (see `api/README.md`)
- `worker/` - Redis worker (see `worker/README.md`)
- `docker/` - Dockerfiles + docker-compose.yml (see `docker/README.md`)
- `k8s/` - plain Kubernetes YAML manifests
- `.github/workflows/` - CI pipeline
- `docs/` - diagrams + debugging cheat sheet

## Progress
- [x] Phase 1 - Docker basics (API + worker containers run standalone)
- [x] Phase 2 - Docker Compose (API + worker + Postgres + Redis, verified end-to-end)
- [x] Phase 3 - Kubernetes core (namespace, Deployments, Services, ConfigMap, Secret, PV/PVC - verified end-to-end incl. Pod-restart data persistence)
- [x] Phase 4 - Ingress (app.local routes to the api Service via NGINX Ingress Controller)
- [x] Phase 5 - Scaling (5 replicas, verified load-balancing across all pods via scripts/hammer-pod.sh)
- [x] Phase 6 - Rolling updates (V1 -> V2 via /version endpoint, readiness-gated rollout, rollback verified)
- [x] Phase 7 - Redis + worker flow end-to-end (single job + burst-of-3 sequential draining, verified via logs/queue length/Postgres)
- [x] Phase 8 - Simulated CD (scripts/simulated-cd.sh polls git, auto-applies k8s/ changes - verified scale-down and scale-up round trips via real git push)
- [x] Phase 9 - GitHub Actions CI (checkout/install/test/build for api+worker; registry-push step documented but disabled - no real registry to push to)
