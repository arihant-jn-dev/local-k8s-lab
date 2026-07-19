# Debugging cheat sheet

Commands added as each phase introduces the concept they inspect.

## Docker (Phase 1)

```
# See running containers
docker ps

# See ALL containers, including stopped ones
docker ps -a

# Follow logs from a container
docker logs -f <container-name>

# Get a shell inside a running container
docker exec -it <container-name> sh

# Inspect image layers / build cache
docker history <image-name>

# Remove a stopped container
docker rm <container-name>

# Common failure: build fails with npm network errors
# -> check whether the public npm registry is reachable at all from this
#    network (curl -m 5 https://registry.npmjs.org). If not, you need the
#    corporate .npmrc mirror passed in as a build secret (see docker/README.md).
```

## Docker Compose (Phase 2)

```
# Start everything (rebuild images if Dockerfiles/app code changed)
docker compose -f docker/docker-compose.yml up -d --build

# See status + health of every service
docker compose -f docker/docker-compose.yml ps

# Follow logs for one service (or omit the name for all of them)
docker compose -f docker/docker-compose.yml logs -f worker

# Open a psql shell directly inside the postgres container
docker compose -f docker/docker-compose.yml exec postgres psql -U appuser -d appdb

# Open a redis-cli shell inside the redis container
docker compose -f docker/docker-compose.yml exec redis redis-cli
#   > LRANGE jobs 0 -1      # see any jobs still queued (BRPOP removes them once picked up)

# Stop everything but KEEP data (named volume survives)
docker compose -f docker/docker-compose.yml down

# Stop everything and WIPE Postgres data too
docker compose -f docker/docker-compose.yml down -v

# Common failure: api/worker exit immediately with a connection error
# -> usually means they started before postgres/redis were ready. Check
#    that depends_on has `condition: service_healthy` (not just the
#    service name) - a plain depends_on only waits for the container to
#    start, not for the DB to accept connections.

# Common failure: "relation users does not exist"
# -> init.sql only runs on Postgres's FIRST boot against an empty data
#    directory. If you changed init.sql after the volume already existed,
#    run `docker compose -f docker/docker-compose.yml down -v` to wipe the
#    volume and let it re-init, or apply the SQL manually via psql.
```

## Kubernetes / Minikube (Phase 3)

```
# All our resources live in one namespace - add -n to every command below,
# or run `kubectl config set-context --current --namespace=local-k8s-lab`
# once so you don't have to keep typing it.

# See all resources at a glance
kubectl get all -n local-k8s-lab

# See pod status, restarts, age
kubectl get pods -n local-k8s-lab

# Get the FULL story on a pod: events, mounts, env vars, probe results -
# this is almost always your first move when something's wrong
kubectl describe pod <pod-name> -n local-k8s-lab

# Logs from a running pod
kubectl logs <pod-name> -n local-k8s-lab
kubectl logs -f deployment/api -n local-k8s-lab   # follow, by deployment name

# Logs from a CRASHED container's previous run (the current one restarted)
kubectl logs <pod-name> -n local-k8s-lab --previous

# Shell into a running pod
kubectl exec -it <pod-name> -n local-k8s-lab -- sh

# Run a one-off command in a pod (e.g. psql inside postgres)
kubectl exec -n local-k8s-lab deployment/postgres -- psql -U appuser -d appdb -c "SELECT * FROM users;"

# See recent cluster events (scheduling failures, pulls, probe failures)
kubectl get events -n local-k8s-lab --sort-by='.lastTimestamp'

# Inspect a Service (does its selector actually match any Pods?)
kubectl describe service api -n local-k8s-lab
kubectl get endpoints api -n local-k8s-lab   # empty = selector matches nothing

# Inspect ConfigMap / Secret values (Secret values are base64, decode with
# `echo <value> | base64 -d`)
kubectl get configmap app-config -n local-k8s-lab -o yaml
kubectl get secret app-secret -n local-k8s-lab -o yaml

# Inspect PV/PVC binding status - STATUS should be "Bound", not "Pending"
kubectl get pv,pvc -n local-k8s-lab

# Nodes (just the one Minikube VM, but useful to check its overall health)
kubectl get nodes
kubectl describe node minikube

# Common failure: pod stuck in "Pending"
# -> usually a PVC that never bound (check `kubectl get pvc`) or a
#    resource request the single Minikube node can't satisfy.

# Common failure: pod in "CrashLoopBackOff" right after `kubectl apply -f k8s/`
# -> likely just startup ordering (api/worker started before
#    postgres/redis were ready) - see k8s/README.md. Give it ~30s and
#    check again before assuming something's actually broken.

# Common failure: hostPath PV pod fails with "no such file or directory"
# -> hostPath requires the directory to already exist on the node unless
#    you set `type: DirectoryOrCreate` in the PV spec.

# Common failure: PVC binds to a different auto-provisioned volume instead
# of the PV you wrote
# -> Minikube has a default StorageClass that auto-provisions storage. Set
#    `storageClassName: ""` on the PVC to force it to bind to your PV
#    instead of triggering dynamic provisioning.

# Common failure: ImagePullBackOff for k8s-lab-api:v1 or k8s-lab-worker:v1
# -> the image was never loaded into Minikube's Docker daemon. Run
#    `minikube image load <image>:v1` (see k8s/README.md).
```

## Ingress (Phase 4)

```
# Is the ingress controller itself running?
kubectl get pods -n ingress-nginx

# Does the Ingress object exist and show the right host?
kubectl get ingress -n local-k8s-lab
kubectl describe ingress api-ingress -n local-k8s-lab

# Check the ingress controller's own logs if routing looks wrong
kubectl logs -n ingress-nginx deployment/ingress-nginx-controller

# Common failure: curl to app.local times out or connection-refuses
# -> on macOS + Docker driver, `minikube tunnel` does NOT expose the
#    ingress controller (it's a NodePort Service here, not LoadBalancer -
#    tunnel only helps LoadBalancer Services). Use:
#      minikube service ingress-nginx-controller -n ingress-nginx --url
#    and hit that URL with an explicit Host header / curl --resolve
#    instead. See k8s/README.md for the full walkthrough.

# Common failure: 404 from NGINX itself (not from the API)
# -> the Host header didn't match any Ingress rule. Double check
#    /etc/hosts has `127.0.0.1 app.local` and you're sending
#    `Host: app.local` (curl --resolve or -H "Host: app.local").

# Common failure: Ingress "ADDRESS" column stays empty forever
# -> normal on the Docker driver without a real LoadBalancer - use the
#    minikube service tunnel approach above instead of waiting on this.
```

## Scaling (Phase 5)

```
# Change replica count
kubectl scale deployment api --replicas=5 -n local-k8s-lab

# Watch Pods come up (or terminate, when scaling down)
kubectl get pods -n local-k8s-lab -l app=api -w

# Confirm the Service sees all of them as valid endpoints
kubectl get endpoints api -n local-k8s-lab

# See which Pod handled which request (tallies /pod responses)
./scripts/hammer-pod.sh http://127.0.0.1:<tunnel-port> 50

# Common failure: new Pods stuck at 0/1 after scaling up
# -> check readinessProbe status with `kubectl describe pod <name>` -
#    a Pod that's Running but not yet Ready won't receive Service traffic.

# Common failure: hammer-pod.sh only ever shows ONE pod name
# -> either you only have 1 replica (`kubectl get pods -l app=api`), or
#    client-side connection reuse is keeping one TCP connection alive
#    across requests. curl -s without --http1.1/-connection-close per
#    request should already open a fresh connection each time; if not,
#    increase the request count.
```

## Rolling updates (Phase 6)

```
# Trigger a rollout by changing the image
kubectl set image deployment/api api=k8s-lab-api:v2 -n local-k8s-lab

# Watch it happen live (run in a separate terminal before/during the update)
kubectl get pods -n local-k8s-lab -l app=api -w

# Block until the rollout finishes (or times out/fails)
kubectl rollout status deployment/api -n local-k8s-lab

# See revision history
kubectl rollout history deployment/api -n local-k8s-lab

# Roll back to the previous revision
kubectl rollout undo deployment/api -n local-k8s-lab

# See both the old and new ReplicaSets a rollout creates
kubectl get replicaset -n local-k8s-lab -l app=api

# Common failure: rollout hangs at "X out of Y new replicas updated"
# -> new Pods aren't passing their readinessProbe. Check:
kubectl describe pod <new-pod-name> -n local-k8s-lab
kubectl logs <new-pod-name> -n local-k8s-lab
#    A bad image (crashes, wrong port, missing env var) shows up exactly
#    like this - the rollout deliberately stalls instead of finishing, so
#    old Pods keep serving traffic until you fix or undo it.

# Common failure: change a Docker image, rebuild with the SAME tag, but
# the cluster still behaves like the old version
# -> minikube image load doesn't reliably overwrite a tag Minikube already
#    has cached. Compare digests (see docker/README.md) and if they
#    differ, scale to 0, `minikube image rm`, reload, scale back up.

# Common failure: kubectl apply afterward "undoes" your rollout undo, or
# vice versa
# -> `kubectl rollout undo` changes the live Deployment without touching
#    your YAML file, so the two can drift out of sync. Re-apply the YAML
#    (with the image tag you actually want) to make it authoritative
#    again.
```

## Redis + worker flow (Phase 7)

```
# Check how many jobs are waiting to be picked up
kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LLEN jobs

# Peek at queued (not-yet-processed) jobs without removing them
kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LRANGE jobs 0 -1

# Watch the worker process jobs live
kubectl logs -f -n local-k8s-lab deployment/worker

# Confirm a job's result actually landed in Postgres
kubectl exec -n local-k8s-lab deployment/postgres -- psql -U appuser -d appdb -c "SELECT * FROM jobs ORDER BY id DESC LIMIT 5;"

# Common failure: queue length grows and never drains
# -> the worker crashed or isn't running. Check:
kubectl get pods -n local-k8s-lab -l app=worker
kubectl logs -n local-k8s-lab deployment/worker --previous   # if it restarted

# Common failure: jobs process but nothing shows up in Postgres
# -> worker connected to Redis fine but not Postgres (or vice versa) -
#    check both sets of env vars are present:
kubectl exec -n local-k8s-lab deployment/worker -- printenv | grep -E "PG|REDIS"

# Want more throughput? Scale the worker - no code changes needed, Redis
# (specifically BRPOP's atomic pop) ensures each job goes to exactly one
# worker replica even with several running:
kubectl scale deployment worker --replicas=3 -n local-k8s-lab
```

## Simulated CD (Phase 8)

```
# Run it in the foreground so you can watch its log directly
./scripts/simulated-cd.sh main 15

# Check what commit it thinks is currently applied
cat .simulated-cd-last-applied-commit

# Force it to re-check "from scratch" (e.g. after manually editing the
# cluster and wanting a full re-apply, or if the state file gets weird)
rm .simulated-cd-last-applied-commit
# next loop iteration will fetch, see this as a "new" state, and since
# it's the first run again it'll just record a fresh baseline - to force
# an actual re-apply, edit the file to contain an older commit SHA instead:
git log --oneline -5              # find a commit before the one you want re-applied
echo "<older-sha>" > .simulated-cd-last-applied-commit

# Common failure: script exits immediately with a merge/fast-forward error
# -> means local main has diverged from origin/main (e.g. you committed
#    locally without pushing, or someone else pushed a conflicting
#    commit). The script only ever fast-forwards - it won't merge or
#    rebase for you. Resolve manually with git pull/rebase, then restart
#    the script.

# Common failure: "nothing to do" every poll, even though you pushed a
# k8s/ change
# -> double check you pushed to the SAME branch the script is watching
#    (first argument, defaults to "main"), and that `git fetch` isn't
#    silently failing (check your network / GitHub auth in that terminal).
```
