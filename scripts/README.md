# scripts/

Small helper scripts for exercising the cluster - not part of the app
itself.

## hammer-pod.sh

Fires many requests at the API's `/pod` endpoint and tallies which Pod
name answered each one. Proves the `api` Service load-balances across all
matching Pods instead of always hitting the same one.

```
minikube service api -n local-k8s-lab --url   # get a tunnel URL, keep it running
./scripts/hammer-pod.sh http://127.0.0.1:<port> 50
```

## simulated-cd.sh

A tiny stand-in for ArgoCD (Phase 8) - treats this git repo as the source
of truth for what should be running in the cluster, and continuously
syncs the two.

```
./scripts/simulated-cd.sh main 15   # branch, poll interval in seconds (both optional)
```

Every `poll interval` seconds it:
1. `git fetch`es the branch and compares the remote HEAD to the last
   commit it applied (tracked in `.simulated-cd-last-applied-commit`,
   gitignored - local runtime state, not something to commit).
2. If there are new commits AND any of them touch `k8s/`, it pulls
   (fast-forward only) and runs `kubectl apply -f k8s/`.
3. If there are new commits but none touch `k8s/`, it just advances its
   bookmark without deploying anything - a docs/app-code-only commit
   shouldn't trigger a redeploy.

Leave it running in a terminal, then push a change to any `k8s/*.yaml`
file from another terminal (or another machine) and watch it pick up and
apply the change with no `kubectl` command run by a human. See
`k8s/README.md` for a full walkthrough and what this deliberately does
NOT do compared to real ArgoCD.
