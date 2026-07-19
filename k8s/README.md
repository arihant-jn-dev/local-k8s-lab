# k8s/

Plain Kubernetes YAML manifests (no Helm) that recreate the Phase 2 Compose
stack inside Kubernetes, via Minikube.

## Files (applied in this order - numbered for that reason)
- `00-namespace.yaml` - the `local-k8s-lab` namespace everything else lives in.
- `01-configmap.yaml` - non-secret config (hosts, ports, db name).
- `02-secret.yaml` - Postgres username/password (base64-encoded, not encrypted).
- `03-postgres-init-configmap.yaml` - the `init.sql` that creates `users`/`jobs`.
- `04-postgres-storage.yaml` - PersistentVolume + PersistentVolumeClaim for Postgres.
- `05-postgres.yaml` - Postgres Deployment + Service.
- `06-redis.yaml` - Redis Deployment + Service.
- `07-api.yaml` - API Deployment + Service (NodePort, so we can reach it from the host).
- `08-worker.yaml` - Worker Deployment (no Service - nothing calls it over the network).
- `09-ingress.yaml` - Ingress routing the `app.local` hostname to the `api` Service.

## Before applying: get your images into Minikube

Kubernetes can't see images that only exist in your host's Docker daemon.
Minikube runs its own separate Docker daemon inside the VM, so images built
on your host have to be explicitly loaded in - there's no registry involved
since this is entirely local:

```
docker build -f docker/Dockerfile.api -t k8s-lab-api:v1 .
docker build -f docker/Dockerfile.worker -t k8s-lab-worker:v1 .
minikube image load k8s-lab-api:v1
minikube image load k8s-lab-worker:v1
```

Every Deployment sets `imagePullPolicy: Never` for exactly this reason -
it tells Kubernetes "don't try to pull this from a registry, only use
what's already loaded here."

## Applying everything

```
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml
kubectl apply -f k8s/02-secret.yaml
kubectl apply -f k8s/03-postgres-init-configmap.yaml
kubectl apply -f k8s/04-postgres-storage.yaml
kubectl apply -f k8s/05-postgres.yaml
kubectl apply -f k8s/06-redis.yaml
kubectl apply -f k8s/07-api.yaml
kubectl apply -f k8s/08-worker.yaml
```

(Or `kubectl apply -f k8s/` to apply every file at once - kubectl applies
them all and Kubernetes sorts out most ordering issues itself, though
Deployments may crash-loop a few times before their dependencies are
ready - see "Startup ordering" below.)

## Reaching the API from your host (without Ingress)

Minikube on macOS with the Docker driver can't route directly to Pod/Node
IPs from the host - `minikube service` opens a tunnel instead:

```
minikube service api -n local-k8s-lab --url
```

This prints a `http://127.0.0.1:<port>` URL and keeps running in the
foreground (the tunnel only exists while this command is alive) - run it in
a separate terminal tab, or in the background if you're scripting against it.

## Ingress - reaching the API via app.local (Phase 4)

First, enable the addon and give it a moment to come up:

```
minikube addons enable ingress
kubectl get pods -n ingress-nginx -w   # wait for ingress-nginx-controller to reach 1/1
```

Add a hosts entry so your machine treats `app.local` as this cluster
(one-time, needs sudo):

```
sudo sh -c 'echo "127.0.0.1 app.local" >> /etc/hosts'
```

Apply the Ingress:

```
kubectl apply -f k8s/09-ingress.yaml
kubectl get ingress -n local-k8s-lab
```

### The tricky part: reaching it from macOS + Docker driver

On Linux, `minikube tunnel` gives the ingress controller's Service a real
`EXTERNAL-IP` and `http://app.local` just works. On macOS with the Docker
driver, minikube's ingress addon installs `ingress-nginx-controller` as a
**NodePort** Service (not LoadBalancer) - `minikube tunnel` only assigns
external IPs to LoadBalancer-type Services, so it does nothing useful here
even though it runs without error. Don't be fooled by it starting cleanly.

The reliable way to reach it is the same trick as reaching any other
Service - tunnel to the ingress controller itself:

```
minikube service ingress-nginx-controller -n ingress-nginx --url
```

This prints two URLs (one for port 80, one for 443). Use the first one and
send the `app.local` Host header explicitly, since the tunnel's local port
isn't 80 so `http://app.local` alone won't hit it:

```
curl --resolve app.local:<port>:127.0.0.1 http://app.local:<port>/health
```

(Because `/etc/hosts` maps `app.local` to `127.0.0.1` but doesn't know
about the tunnel's random port, `--resolve` fills in that gap for curl. A
browser needs the port typed explicitly instead: `http://app.local:<port>/health`.)

## Scaling (Phase 5)

```
kubectl scale deployment api --replicas=5 -n local-k8s-lab
kubectl get pods -n local-k8s-lab -l app=api -w   # watch new Pods come up
```

Scaling only changes how many Pods the `api` Deployment's ReplicaSet
keeps running - the `api` Service doesn't need any changes at all, since
it already selects Pods by label (`app: api`), not by name or count. Every
matching Pod automatically joins the Service's load-balancing rotation the
moment its readiness probe passes, and leaves the moment it's terminated.

Prove it with `scripts/hammer-pod.sh` (see `scripts/README.md`) - it fires
many requests at `/pod` and tallies which Pod name answered each one:

```
minikube service api -n local-k8s-lab --url
./scripts/hammer-pod.sh http://127.0.0.1:<port> 50
```

Scaling back down works the same way - Kubernetes picks Pods to terminate
and immediately stops routing to them (no changes needed on your part):

```
kubectl scale deployment api --replicas=2 -n local-k8s-lab
```

## Rolling updates (Phase 6)

The API has a `GET /version` endpoint (returns `{"version": "V1"}` or
`"V2"`) baked into the image via a Docker `ARG`/`ENV` - see
`docker/README.md`. This gives us something visible to watch change
mid-rollout, the same way the spec's "Hello V1 / Hello V2" idea does.

Build both versions and load them into Minikube:

```
docker build --build-arg VERSION=V1 -f docker/Dockerfile.api -t k8s-lab-api:v1 .
docker build --build-arg VERSION=V2 -f docker/Dockerfile.api -t k8s-lab-api:v2 .
minikube image load k8s-lab-api:v1
minikube image load k8s-lab-api:v2
```

`k8s/07-api.yaml`'s Deployment now has an explicit `strategy.rollingUpdate`
block (`maxUnavailable: 1`, `maxSurge: 1`) - this replaces Pods a couple at
a time instead of an all-at-once "Recreate" strategy, which would cause a
full outage during every deploy.

Trigger a rollout by changing the image tag - either edit the YAML and
`kubectl apply`, or for a quick one-off:

```
kubectl set image deployment/api api=k8s-lab-api:v2 -n local-k8s-lab
kubectl rollout status deployment/api -n local-k8s-lab   # watch it finish
```

While it's running, in another terminal:

```
kubectl get pods -n local-k8s-lab -l app=api -w
```

You'll see old Pods (`api-<hash1>-...`) and new Pods (`api-<hash2>-...`)
briefly coexist - the readinessProbe on the new Pods must pass before
Kubernetes moves on to terminating more old ones, which is exactly how a
broken new image gets caught: it fails readiness, the rollout stalls
instead of taking down the whole Service.

Roll back if something's wrong:

```
kubectl rollout undo deployment/api -n local-k8s-lab
```

If you use `rollout undo`, remember it bypasses the YAML file - re-apply
`k8s/07-api.yaml` afterward (with whichever image tag you actually want)
so the tracked manifest and the live cluster don't drift apart. This
matters more once Phase 8 treats the YAML as the source of truth for a
GitOps-style flow.

## Concepts introduced in this phase

- **Node** - a machine (physical or virtual) in the cluster. Minikube gives
  you exactly one Node, so there's no multi-node scheduling to reason
  about yet.
- **Cluster** - the whole set of Nodes plus the control plane that manages
  them.
- **Pod** - the smallest deployable unit; one or more containers that
  always run together on the same Node, sharing network/storage.
- **ReplicaSet** - ensures a fixed number of identical Pods are running;
  created and managed for you by a Deployment.
- **Deployment** - declares desired state (image, replica count, env vars)
  for a set of Pods; the thing you actually create and edit.
- **Service** - a stable DNS name + virtual IP for a set of Pods, since
  individual Pod IPs change every time a Pod is recreated.
- **ConfigMap** - non-secret key-value config, injected into Pods as env
  vars or mounted files.
- **Secret** - like a ConfigMap, but for sensitive values (base64-encoded,
  not encrypted - don't mistake this for real security).
- **Volume / PersistentVolume / PersistentVolumeClaim** - how Pods get
  storage that outlives the Pod itself. A PV is an actual piece of disk; a
  PVC is a request for storage that gets "bound" to a matching PV.
- **Scheduler** - the control-plane component that decides which Node each
  new Pod runs on (trivial here with only one Node).
- **Container runtime** - the software that actually runs containers on a
  Node (Minikube uses Docker's runtime here, configured via `--driver=docker`).

## Startup ordering: no `depends_on` in Kubernetes

Unlike Compose's `depends_on: condition: service_healthy`, raw Kubernetes
has no built-in "wait for that other Deployment to be ready" concept.
When you `kubectl apply` everything at once, api/worker Pods can start
before Postgres/Redis are ready and will crash with connection errors.

This is expected and self-heals: Kubernetes automatically restarts crashed
containers with exponential backoff (`CrashLoopBackOff`), so once
Postgres/Redis become ready, the next retry succeeds. Give it 30-60
seconds and check `kubectl get pods -n local-k8s-lab` - everything should
settle to `1/1 Running`.
