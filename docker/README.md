# docker/

Dockerfiles and `docker-compose.yml` for running the whole stack locally
before we move to Kubernetes.

## Files
- `Dockerfile.api` - builds the `api/` app into an image.
- `Dockerfile.worker` - builds the `worker/` app into an image.
- `docker-compose.yml` - wires api + worker + postgres + redis together.
  This is the "before Kubernetes" baseline - compare it to the k8s/
  manifests in Phase 3 to see what Kubernetes adds (scheduling, self-healing,
  Services vs. Compose's built-in DNS, etc).
- `init.sql` - creates the `users` and `jobs` tables. Postgres runs this
  automatically only on the *first* boot against an empty data directory.

## Running the full stack

```
docker compose -f docker/docker-compose.yml up -d --build
```

Then:
```
curl http://localhost:3000/health
curl -X POST http://localhost:3000/users -H "Content-Type: application/json" -d '{"name":"Ada","email":"ada@example.com"}'
curl http://localhost:3000/users
curl -X POST http://localhost:3000/jobs -H "Content-Type: application/json" -d '{"task":"demo"}'
docker compose -f docker/docker-compose.yml logs -f worker   # watch it process the job
```

Tear down with `docker compose -f docker/docker-compose.yml down` (keeps
the `pgdata` volume - your users survive) or add `-v` to wipe the database
too.

## Why the build context matters
Both Dockerfiles are built from the **repo root**, not from inside
`docker/`, because they need to `COPY api/` or `COPY worker/`. Example:

```
docker build -f docker/Dockerfile.api -t k8s-lab-api:v1 .
```

The trailing `.` is the build context (repo root) - that's what makes
`COPY api/package.json ./` inside the Dockerfile work.

## Building the images

Both Dockerfiles just `RUN npm install` against the public npm registry -
no special registry config needed:

```
docker build -f docker/Dockerfile.api -t k8s-lab-api:v1 .
docker build -f docker/Dockerfile.worker -t k8s-lab-worker:v1 .
```

(If you're ever on a network that blocks the public npm registry - e.g. a
locked-down corporate network - see the "npm registry blocked" note at the
bottom of this file for the workaround we used earlier in this project.)

## VERSION build arg (Phase 6 - rolling updates)
`Dockerfile.api` accepts a `VERSION` build arg (defaults to `V1`) and bakes
it in as an `ENV`, so the API's `GET /version` reports which image build
is running. This is what lets a rolling update from `k8s-lab-api:v1` to
`k8s-lab-api:v2` be visibly different, the same way the spec's
"Hello V1 / Hello V2" idea works:

```
docker build --build-arg VERSION=V1 -f docker/Dockerfile.api -t k8s-lab-api:v1 .
docker build --build-arg VERSION=V2 -f docker/Dockerfile.api -t k8s-lab-api:v2 .
```

## How it connects to the rest of the system
- Images built here get loaded into Minikube starting Phase 3
  (`minikube image load`), since nothing gets pushed to a real registry.

## Gotcha: `minikube image load` can serve a stale image under the same tag
If you rebuild an image but keep the same tag (e.g. rebuilding `v1` after
changing app code), `minikube image load` doesn't reliably overwrite what
Minikube's internal Docker daemon already has cached under that tag -
Pods can keep running the OLD content indefinitely with no error anywhere.

If a change doesn't seem to be taking effect inside the cluster, don't
trust the tag - compare digests:

```
docker images --no-trunc | grep k8s-lab-api      # your host's build
minikube ssh -- docker images --no-trunc | grep k8s-lab-api   # what Minikube actually has
```

If they don't match, scale the Deployment to 0 first (so no container
holds a reference to the old image), then remove and reload:

```
kubectl scale deployment api --replicas=0 -n local-k8s-lab
# wait for old pods to fully terminate (kubectl get pods -w)
minikube image rm k8s-lab-api:v1
minikube image load k8s-lab-api:v1
kubectl scale deployment api --replicas=5 -n local-k8s-lab
```

Using distinct tags per version (like `v1`/`v2` here) avoids this problem
entirely for new versions - it only bites you when you rebuild and reuse
an existing tag.

## npm registry blocked? (e.g. locked-down corporate network)

If `npm install` fails inside the build with `ETIMEDOUT` against
`registry.npmjs.org`, some networks block direct access to the public npm
registry entirely. Check for a corporate mirror in `~/.npmrc` (often an
Artifactory-style URL with an auth token), then pass it into the build as
a BuildKit secret instead of baking the token into an image layer:

```
docker build --secret id=npmrc,src=$HOME/.npmrc -f docker/Dockerfile.api -t k8s-lab-api:v1 .
```

This needs a matching `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm install --omit=dev`
line added back into the Dockerfile (currently removed since this isn't
needed on a normal home network) and the equivalent `secrets:` block in
`docker-compose.yml`.
