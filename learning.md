Phase 1: build the two images from scratch and prove they work standalone.
docker build -f docker/Dockerfile.api -t k8s-lab-api:v1 .
docker build -f docker/Dockerfile.worker -t k8s-lab-worker:v1 .

Building = following this Dockerfile line by line to produce a self-contained, runnable filesystem snapshot (the "image")
So after docker build finishes, you have k8s-lab-api:v1 sitting in your local Docker image cache — a frozen, portable snapshot .

docker build → creates the image (k8s-lab-api:v1) — inert, just sitting in Docker's local storage, doing nothing.
docker run → takes that image and starts a container from it — that's the actual live, running process (Node.js executing index.js, listening on a port, etc).


bring up the full Compose stack instead (Postgres + Redis + API + worker together):
docker compose -f docker/docker-compose.yml up -d --build

docker compose -f docker/docker-compose.yml — use that specific compose file (since we're not running the command from inside docker/) to know what services exist: postgres, redis, api, worker.
up — create and start all 4 of those containers, plus a shared private network between them so they can reach each other by service name (this is exactly the network that makes redis resolve correctly, unlike the standalone test we just discussed).
--build — rebuild the api and worker images from their Dockerfiles + current source first, instead of reusing whatever image existed before (Postgres/Redis are pre-built, so they just get pulled/reused as-is).
-d — detached, runs in the background instead of blocking your terminal with logs.
Net effect: after this finishes, you'll have all 4 containers running together on one shared network.


Then check they're all healthy:
docker compose -f docker/docker-compose.yml ps

Now check : 
arihant.ja@MMMDVARIHANTJA local-k8s-lab % curl http://localhost:3000/health
arihant.ja@MMMDVARIHANTJA local-k8s-lab % curl http://localhost:3000/pod
arihant.ja@MMMDVARIHANTJA local-k8s-lab % curl http://localhost:3000/users
arihant.ja@MMMDVARIHANTJA local-k8s-lab % curl -X POST http://localhost:3000/users -H "Content-Type: application/json" -d '{"name":"Ada","email":"ada@example.com"}'
//redis/worker job 
arihant.ja@MMMDVARIHANTJA local-k8s-lab % curl -X POST http://localhost:3000/jobs -H "Content-Type: application/json" -d '{"task":"demo"}'


The API immediately responded "status":"queued" — it pushed the job onto Redis and returned right away, without waiting for it to actually be processed. That's the async decoupling the queue provides.

The worker takes ~5 seconds to "process" it (simulated work) before writing the result to Postgres. Let's wait a moment, then check its logs.

Next single command:
docker compose -f docker/docker-compose.yml logs worker --tail=10

Next single command — confirm that result actually landed in Postgres:
arihant.ja@MMMDVARIHANTJA local-k8s-lab % docker compose -f docker/docker-compose.yml exec postgres psql -U appuser -d appdb -c "SELECT * FROM jobs;"


Phase 2 (Docker Compose) is fully verified end-to-end — Postgres CRUD, and the full Redis→worker→Postgres job pipeline, all working from a completely clean rebuild.

Let's tear this down cleanly before moving to Kubernetes, so we don't have Compose and Minikube both running against port conflicts later.
Next single command:
docker compose -f docker/docker-compose.yml down

(This keeps the pgdata volume, so your Ada Lovelace user data would survive if you brought it back up — but we're moving to Kubernetes next, so it won't matter either way.) Run just that and let me know when it's done.

Phase 3 : 
minikube start --driver=docker
:This command creates a brand-new local Kubernetes cluster on your machine.

minikube — a tool that runs a real, single-node Kubernetes cluster locally, so you can learn/test Kubernetes without a real multi-machine cluster or cloud account.
start — actually creates and boots that cluster (as opposed to stop, which pauses it, or delete, which destroys it — which we did earlier).
--driver=docker — tells Minikube to run the cluster's "node" as a Docker container on your Mac, rather than a full virtual machine (VirtualBox, HyperKit, etc). Since you already have Docker Desktop running, this is the lightest-weight option — no separate VM software needed.

Why we need this at all: everything we did in Phase 1-2 (docker run, docker compose) only used plain Docker — no Kubernetes concepts (Pods, Deployments, Services, etc). Phase 3 onward is specifically about learning Kubernetes, and Kubernetes needs an actual cluster to talk to — kubectl apply doesn't do anything without one. Minikube gives you that cluster locally, for free, without needing a real production Kubernetes setup.

running this command will:
Download/reuse a small "base image" that acts as the cluster's node
Start that as a container (you'll actually see it show up in docker ps as a container named minikube)
Install and start Kubernetes's own internal components inside that container (API server, scheduler, etc.)
Configure your local kubectl to point at this new cluster automatically

After it finishes, 
arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl get nodes 
it will show one node called minikube, Ready.
Cluster is up and ready — one node called minikube, Ready status, running Kubernetes v1.35.1.

##
Since we deleted the cluster earlier, it's completely empty right now — no namespaces, no deployments, nothing of ours exists in it yet. Before we apply anything, we need to get our two app images (k8s-lab-api, k8s-lab-worker) into this new cluster's own separate Docker daemon — remember, Minikube's node runs its own Docker, isolated from your Mac's Docker.

Next single command — load the API image in:
minikube image load k8s-lab-api:v1
Next single command — load the worker image too:
minikube image load k8s-lab-worker:v1


Both images are now inside Minikube's own Docker daemon. Let's also load the v2 API image now, since Phase 6 (rolling updates) will need it later and it's easier to do all image-loading together.

Next single command:
minikube image load k8s-lab-api:v2

Where we are: Minikube gave us an empty Kubernetes cluster. We loaded our 3 images into it. But the cluster still has zero knowledge of our app — no namespace, no deployments, nothing. 
Images sitting in Minikube's Docker daemon don't do anything by themselves; Kubernetes needs to be told "run a container from this image" via YAML manifests.

Why the namespace first: Every other manifest we apply (ConfigMap, Secret, Deployments, Services) will say namespace: local-k8s-lab in it. If that namespace doesn't exist yet, those kubectl apply commands would fail. So this has to go first — it's just a named "folder" inside the cluster to keep our stuff grouped and separate from Kubernetes's own system namespaces.
Next single command:
kubectl apply -f k8s/00-namespace.yaml
Namespace created. 

Now let's add the ConfigMap and Secret next — these need to exist before the Postgres/API/worker Deployments, because those Deployments reference them (configMapKeyRef, secretKeyRef) to pull in things like the database hostname and password as environment variables. Applying them first avoids any dependency errors.
Next single command:
kubectl apply -f k8s/01-configmap.yaml
ConfigMap created. 

Now the Secret — same reasoning, it holds the Postgres username/password that the Deployments will reference, so it needs to exist before them too.
Next single command:
kubectl apply -f k8s/02-secret.yaml
Secret created. 

Next we need the Postgres init-SQL ConfigMap — this holds the CREATE TABLE statements for users/jobs. It has to exist before the Postgres Deployment, because that Deployment mounts this ConfigMap as a file into Postgres's init directory, so the tables get created automatically the very first time Postgres boots.
Next single command:
kubectl apply -f k8s/03-postgres-init-configmap.yaml
Init-SQL ConfigMap created. 

Now we need Postgres's actual storage — a PersistentVolume + PersistentVolumeClaim. This has to exist before the Postgres Deployment, because that Deployment mounts this PVC as its data directory. Without real storage backing it, Postgres's data would live only inside the Pod's own filesystem and vanish the instant the Pod restarts — the PV/PVC is what makes the data actually survive.
Next single command:
kubectl apply -f k8s/04-postgres-storage.yaml
Storage is set up. 

Now everything Postgres needs exists (Secret for credentials, ConfigMap for init SQL, PV/PVC for storage) — so let's actually deploy Postgres itself.
Next single command:
kubectl apply -f k8s/05-postgres.yaml
Postgres Deployment + Service created. 

Now Redis — simpler, no storage needed since it's just a job queue, fine to lose in-progress data on a restart for this learning project.
Next single command:
kubectl apply -f k8s/06-redis.yaml
Redis is up. 

Now the API — this one references the ConfigMap/Secret for its DB/Redis connection details, and needs the k8s-lab-api:v2 image we already loaded into Minikube. It also creates a NodePort Service so we can reach it from outside the cluster later.
Next single command:
kubectl apply -f k8s/07-api.yaml
API Deployment + Service created. 

Now the worker — same environment variables, but no Service, since nothing ever needs to call the worker over the network; it only reaches out to Redis and Postgres.
Next single command:
kubectl apply -f k8s/08-worker.yaml

All manifests applied. Now let's actually check whether everything came up healthy — this is the important verification step, since Kubernetes has no depends_on like Compose does, so the API/worker may briefly crash-loop while waiting for Postgres/Redis to become ready before self-healing.

Next single command:
kubectl get pods -n local-k8s-lab

All 8 pods are 1/1 Running with zero restarts — everything came up cleanly on the first try this time (no crash-loop race, since Postgres/Redis happened to be ready before api/worker tried connecting). 5 API replicas, 1 Postgres, 1 Redis, 1 worker — matches exactly what our manifests declare.

Let's now actually test the API through the cluster, not just confirm the pods exist. 
Since we're on macOS with the Docker driver, we can't reach the cluster's internal IPs directly from your Mac — we need minikube service to open a tunnel.

Next single command:
minikube service api -n local-k8s-lab --url

Good, tunnel is up at http://127.0.0.1:61542 and needs that terminal to stay open. Open a new terminal tab for the next commands so this tunnel keeps running.

Let's test /health through the cluster first:
curl http://127.0.0.1:61542/health

Health check passes through the full chain: your curl → Minikube tunnel → NodePort Service → one of the 5 API Pods → back to you.

Now let's check /pod — this is the interesting one in Kubernetes, since hostname should now show an actual Pod name instead of a random container ID like it did in plain Docker.
arihant.ja@MMMDVARIHANTJA local-k8s-lab % curl http://127.0.0.1:61542/pod
{"hostname":"api-7d6c94fb48-htq99","version":"V2","timestamp":"2026-07-19T20:06:58.584Z"}%   

Exactly what we want to see — hostname: "api-7d6c94fb48-htq99" is a real Pod name from your kubectl get pods list above, not a random container ID like plain Docker gave us. This is the mechanism Phase 5 (scaling) will use to prove load-balancing: fire this same request many times, and with 5 replicas you should see 5 different Pod names answering.

Also notice "version":"V2" — confirms the API Deployment is running the k8s-lab-api:v2 image, matching what's in k8s/07-api.yaml.

Load-balancing confirmed — 5 requests, 3 different Pod names answering (rdnjv, htq99, wf4bz), roughly round-robin. This is the Service doing its job: distributing traffic across all 5 matching Pods, exactly what Phase 5's dedicated test (scripts/hammer-pod.sh) will formalize with a larger sample and a tally.

We've now verified: cluster up, images loaded, all 8 Pods healthy, health check working, Pod-name identity working, and load-balancing working — that's Phase 3 + a preview of Phase 5, all confirmed live.

Next, let's test the Postgres and Redis/worker flow through Kubernetes, same as we did in Compose. First, users:
curl http://127.0.0.1:61542/users

Let's add a user to confirm the write path works through Kubernetes:
curl -X POST http://127.0.0.1:61542/users -H "Content-Type: application/json" -d '{"name":"Grace Hopper","email":"grace@example.com"}'

Now let's test the Redis/worker flow through Kubernetes — post a job:
curl -X POST http://127.0.0.1:61542/jobs -H "Content-Type: application/json" -d '{"task":"k8s-fresh-test"}'

Job queued — the API Pod pushed it onto the redis Service's queue and returned immediately, same async pattern as Compose.
The worker Pod takes ~5 seconds to pick it up and "process" it (simulated work) before writing the result to Postgres. Let's check its logs:
kubectl logs -n local-k8s-lab deployment/worker --tail=10

Full end-to-end Redis→worker flow confirmed inside Kubernetes: picked up the job, processed it, wrote the result, logged Completed — identical behavior to Compose, just running as Pods instead of plain containers.

Let's do the final check — confirm the job actually landed in Postgres:
kubectl exec -n local-k8s-lab deployment/postgres -- psql -U appuser -d appdb -c "SELECT * FROM jobs;"

Phase 3 (Kubernetes core) is now fully verified end-to-end, from a completely clean cluster: all pods healthy, ConfigMap/Secret wiring works, PV/PVC-backed Postgres works, Redis queue works, worker processing works, and we even got a free preview of Phase 5's load-balancing along the way.

Here's where we stand:

✅ Phase 1 — Docker basics
✅ Phase 2 — Docker Compose
✅ Phase 3 — Kubernetes core


Next up would be Phase 4 (Ingress) — testing app.local routing instead of the minikube service tunnel we've been using. Want to continue to that now, or take a pause here?

What Ingress is: 
Right now, the only way to reach our API from outside the cluster is minikube service opening a temporary tunnel to a raw port number (like 61542). That's fine for testing, but it's not how real traffic reaches a cluster. 
An Ingress is a Kubernetes resource that gives you actual hostname-based routing — "requests for 
app.local go to the api Service" — the way a real production system would route yourapp.com to the right backend.

What we'll actually do in this phase:
Enable Minikube's NGINX ingress controller addon (installs that controller Pod)
Apply our k8s/09-ingress.yaml (the rule: app.local → api Service)
Add app.local to your /etc/hosts so your Mac treats that fake hostname as this cluster
Test it — and there's a known gotcha here worth remembering: on macOS with the Docker driver, minikube tunnel (the usual advice) doesn't actually help for this addon, since it installs as a NodePort Service, not LoadBalancer. We'll use minikube service on the ingress controller itself instead, same trick as before.

First step: turn on the NGINX Ingress Controller — this is the actual running component that will read our Ingress rule and act on it. Without this enabled, applying an Ingress resource would just sit there with nothing implementing it.

Next single command:
minikube addons enable ingress

Let's confirm the controller Pod actually came up and is ready, before we apply our Ingress rule :
kubectl get pods -n ingress-nginx

Now let's apply our actual Ingress rule — this tells the controller "route requests for app.local to the api Service."
Next single command:
kubectl apply -f k8s/09-ingress.yaml

Ingress rule created. Let's confirm it registered correctly.
Next single command:
kubectl get ingress -n local-k8s-lab

Ingress is registered — app.local hostname routing through the nginx class, port 80. Now we need two things before we can actually test it: (1) map app.local to 127.0.0.1 in your /etc/hosts, and (2) a tunnel to actually reach the ingress controller from your Mac, since we're on Docker driver / macOS.

Step 1 needs sudo, which needs your own interactive terminal (I can't run it from my sandbox). Please run:
sudo sh -c 'echo "127.0.0.1 app.local" >> /etc/hosts'
app.local now resolves to 127.0.0.1

Now step 2: since ingress-nginx here runs as a NodePort Service (not LoadBalancer), minikube tunnel won't help — we need minikube service on the ingress controller itself instead, same tunnel trick we used for the API earlier.

Next single command:
minikube service ingress-nginx-controller -n ingress-nginx --url

Two tunnels open — the first (62605) maps to port 80 (HTTP), the second (62606) to port 443 (HTTPS, which we don't use here). Leave this terminal open.

Now, in a different terminal tab, let's test it. Since the tunnel's local port isn't 80, plain http://app.local won't work — we need to send the app.local Host header explicitly while hitting the tunnel's actual port: curl -H "Host: app.local" http://127.0.0.1:62605/health

Ingress routing confirmed working — your request went through the tunnel → NGINX ingress controller → matched the app.local Host header → routed to the api Service → to one of the 5 Pods → {"status":"ok"}.

Let's also verify with curl --resolve, which more accurately simulates what actually happens once /etc/hosts + a browser are involved (it makes curl treat app.local as resolving to this address, rather than us faking the header manually):
curl --resolve app.local:62605:127.0.0.1 http://app.local:62605/pod

Confirmed — using the actual app.local hostname (not a faked header), routed correctly through the Ingress to Pod rdnjv, running V2.
Phase 4 (Ingress) is fully verified. You now have two working ways to reach the API: the direct minikube service api tunnel from Phase 3, and this hostname-based Ingress routing.

type on a Kubernetes Service controls how reachable it is — from where. There are 3 relevant types here:
ClusterIP (the default, used by Postgres and Redis) — only reachable from inside the cluster, by other Pods. Nothing outside the cluster can talk to it at all. This is exactly right for a database and a queue — you never want those exposed to the outside world.

NodePort (used by the api Service) — opens a specific port on the Node itself (the Minikube VM), reachable from outside the cluster too, not just from other Pods. That's why the API — the thing meant to actually receive external traffic — uses this, while Postgres/Redis don't.

LoadBalancer (not used in this project, mentioned in the ingress-nginx discussion) — normally provisions a real cloud load balancer with a public IP. Doesn't really apply locally the way it would on AWS/GCP; that's why minikube tunnel behaves oddly here.

Why we still needed minikube service even with NodePort: NodePort should be directly reachable at <node-ip>:<nodeport> in a normal setup. But on macOS with the Docker driver, your Mac can't route directly into the Minikube VM's internal network — so minikube service acts as a tunnel that forwards a local port on your Mac straight to that NodePort. That's purely a macOS/Docker-driver quirk, not something inherent to NodePort itself.

## Phase 5 (Scaling).
Current state: we already have 5 API replicas running (from k8s/07-api.yaml's replicas: 5).
arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl get pods -n local-k8s-lab -l app=api

Confirmed — 5 replicas, all healthy, no restarts. Now let's actually exercise scaling instead of just observing the resting state. First, let's explicitly scale down to 2, so we can watch Kubernetes tear down Pods, then scale back up and watch it create new ones — that's the real "scaling" behavior to observe.

Next single command:
kubectl scale deployment api --replicas=2 -n local-k8s-lab

You can see it happening live — Kubernetes picked 2 Pods to keep (htq99, wf4bz — Running) and marked the other 3 for teardown (Terminating). This is the ReplicaSet reconciling: it noticed "desired state says 2, but I have 5" and started removing the excess.
Let's confirm it settles at exactly 2:
kubectl get pods -n local-k8s-lab -l app=api

Now let's prove the Service correctly stopped routing to the terminated Pods too — not just that they're gone, but that traffic genuinely only reaches these 2 survivors. Let's use the hammer-pod.sh script for this properly, since that's exactly what it's built for.
arihant.ja@MMMDVARIHANTJA local-k8s-lab % ./scripts/hammer-pod.sh http://127.0.0.1:61542 20
Exactly as expected — 20 requests, only the 2 surviving Pods (htq99, wf4bz) answered, split roughly evenly (12/8). No stale routing to the 3 terminated Pods at all.

Now let's scale back up to 5 and prove the reverse — new Pods join the rotation the moment they're ready.
arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl scale deployment api --replicas=5 -n local-k8s-lab
arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl get pods -n local-k8s-lab -l app=api

Let's fire a bigger batch of requests now to confirm all 5 join the rotation, not just the 2 old ones.
arihant.ja@MMMDVARIHANTJA local-k8s-lab % ./scripts/hammer-pod.sh http://127.0.0.1:61542 50

Phase 5 (Scaling) is fully verified — both scale-down (traffic correctly stops reaching terminated Pods) and scale-up (new Pods join automatically) confirmed with real data, not just the earlier passive observation.

## Phase 6 (Rolling updates):
we'll roll the API from V1 to V2 (or since we're already on V2, we'll roll V2 back to V1 and then forward again) and watch old/new Pods coexist during the transition. 

Good. Brief context for Phase 6: right now all 5 API Pods are running image k8s-lab-api:v2 (we confirmed this earlier via /pod showing "version":"V2"). This phase is about changing that image while the app stays live — watching Kubernetes replace Pods gradually (not all at once), and seeing how the readinessProbe protects you if a new version were broken.
Since we're already on V2, let's roll back to V1 first (a real image change we can observe), then roll forward to V2 again — that way we exercise the mechanism in both directions.

Let's first confirm what's actually in the manifest right now:
grep "image: k8s-lab-api" k8s/07-api.yaml

Now let's trigger a rolling update to v1 using kubectl set image — a live change to the Deployment, and then we'll watch it happen.

Next single command:
kubectl set image deployment/api api=k8s-lab-api:v1 -n local-k8s-lab

Update triggered. Kubernetes is now replacing Pods gradually behind the scenes. Let's watch it happen live — this shows old and new Pods coexisting mid-rollout.

Next single command:
kubectl get pods -n local-k8s-lab -l app=api

arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl get pods -n local-k8s-lab -l app=api
NAME                   READY   STATUS        RESTARTS   AGE
api-68db86f6b5-c4r7t   1/1     Running       0          20s
api-68db86f6b5-ddcj2   1/1     Running       0          27s
api-68db86f6b5-fs2mz   1/1     Running       0          27s
api-68db86f6b5-qbd5f   1/1     Running       0          34s
api-68db86f6b5-rdc2h   1/1     Running       0          34s
api-7d6c94fb48-hdfgk   1/1     Terminating   0          10m
api-7d6c94fb48-htq99   1/1     Terminating   0          73m
api-7d6c94fb48-wf4bz   1/1     Terminating   0          73m
api-7d6c94fb48-wwfbc   1/1     Terminating   0          10m

Caught it mid-rollout — you can see it clearly: 5 new Pods (api-68db86f6b5-...) already Running, while all 5 old Pods (api-7d6c94fb48-...) are Terminating. Notice the hash in the Pod name changed too (7d6c94fb48 → 68db86f6b5) — that's because a new ReplicaSet was created for the new image version, and the old ReplicaSet is being scaled to zero.

Let's confirm it settles cleanly at 5 new Pods, all old ones gone.
Next single command:
kubectl get pods -n local-k8s-lab -l app=api

Rollout complete — 5 Pods, all on the new ReplicaSet, all Running, old ones fully gone.
Let's confirm the actual code running is V1 now, not just that the Pods look different — through the tunnel.
Next single command:
curl http://127.0.0.1:61542/version

Confirmed — V1 is now actually running, not just the Pod hashes changing cosmetically. The rollout genuinely replaced the running code.
Now let's roll forward back to V2, and this time watch the ReplicaSets side-by-side to see Kubernetes's rollout history in action.
Next single command:
kubectl set image deployment/api api=k8s-lab-api:v2 -n local-k8s-lab
arihant.ja@MMMDVARIHANTJA local-k8s-lab % curl http://127.0.0.1:61542/version



## Phase 7 : 
Good. Brief context for Phase 7: we've already proven the basic Redis→worker→Postgres flow works (once in Compose, once in this fresh Kubernetes cluster). This phase's real value is proving something we haven't specifically shown yet: the worker processes jobs one at a time, in order, because there's only 1 worker Pod. We'll post several jobs in a quick burst and watch the queue drain sequentially, ~5 seconds apart, rather than all at once.
First, let's confirm the queue is currently empty so we have a clean baseline.
Next single command:
kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LLEN jobs

Clean baseline — queue is empty. Now let's post 3 jobs in quick succession, all at once.
Next single command:
for i in 1 2 3; do curl -s -X POST http://127.0.0.1:61542/jobs -H "Content-Type: application/json" -d "{\"task\":\"burst-$i\"}"; echo; done

arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LLEN jobs                                                                     
arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl logs -n local-k8s-lab deployment/worker --tail=20
arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl exec -n local-k8s-lab deployment/postgres -- psql -U appuser -d appdb -c "SELECT id, payload, completed_at FROM jobs ORDER BY id;"


### phase 8 :

Good. Brief context for Phase 8: everything we've done so far required a human to manually run kubectl apply/kubectl scale/etc. This phase flips that: scripts/simulated-cd.sh runs continuously in the background, polling our GitHub repo. When it sees a new commit that touches k8s/, it automatically pulls and runs kubectl apply -f k8s/ — no human running kubectl at all. This is the core idea behind tools like ArgoCD ("GitOps") — git becomes the source of truth, and something else keeps the cluster in sync with it.

First, let's confirm our git state is clean and matches GitHub, since the script only reacts to new commits relative to wherever it starts.
Next single command:
git status

Now let's start the simulated CD script. This needs to run continuously in its own terminal, so open a new terminal tab for this.
Next single command (run in the new tab):
arihant.ja@MMMDVARIHANTJA local-k8s-lab % ./scripts/simulated-cd.sh main 15

Exactly what we wanted to see — it detected the commit, correctly identified that k8s/07-api.yaml changed, pulled, and ran kubectl apply -f k8s/, showing deployment.apps/api configured (the one thing that actually changed) while everything else stayed unchanged. No kubectl command typed by you at all — just a git push.

Let's confirm the cluster actually scaled down to 3 as a result.
Next single command (in your original terminal):
arihant.ja@MMMDVARIHANTJA local-k8s-lab % kubectl get pods -n local-k8s-lab -l app=api

Phase 8 (Simulated CD) is fully re-verified with a real scale-down-to-3 → scale-up-to-5 round trip, both directions triggered purely by git push, with the sync loop doing every kubectl apply automatically.


## Phase 9 (GitHub Actions CI):
Good, last one. Brief context for Phase 9: this one's different from the others — it doesn't run against your Minikube cluster at all. It runs entirely on GitHub's own servers, automatically, 
every time you push. .github/workflows/ci.yml defines two jobs (api, worker), each spinning up a fresh Ubuntu VM that checks out your code, installs dependencies, runs tests (api only), and builds a Docker image — proving the code is good before anyone thinks about deploying it.

Since we've pushed commits multiple times already in this session (Phase 8's re-tests), CI should have already run automatically. Let's just check the results — open this in your browser:
https://github.com/arihant-jn-dev/local-k8s-lab/actions

