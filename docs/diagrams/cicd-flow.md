# Simulated CD: git as source of truth

## Before Phase 8 - manual deploys

```
 you -- edit k8s/*.yaml -- kubectl apply -f k8s/ --> cluster
```

Every deploy requires a human to run kubectl. Nothing enforces that the
YAML files in git actually match what's running - they can silently
drift apart the moment someone runs a one-off `kubectl edit` or
`kubectl scale` without updating the file (this bit us for real in Phase
6, when `kubectl rollout undo` changed the live Deployment out from under
the tracked YAML).

## Phase 8 - simulated CD (this project's ArgoCD stand-in)

```
        git push
you ---------------> GitHub (origin/main)
                            |
                            |  polled every N seconds
                            v
                  scripts/simulated-cd.sh
                  (running continuously in
                   a terminal / background)
                            |
                for commits since last-applied
                that touch k8s/...
                            |
                            v
                  git pull (fast-forward only)
                  kubectl apply -f k8s/
                            |
                            v
                        cluster
```

Now a human's job is "commit and push" - the sync loop is the only thing
that ever runs `kubectl apply`. This is the core idea GitOps tools like
ArgoCD are built around: **the git repo is authoritative**, and some
automated process continuously reconciles the live system toward
whatever's committed, instead of the live system being whatever the last
person to run kubectl happened to type.

## What real ArgoCD adds on top of this

```
        git push                    kubectl edit (manual drift!)
you ---------------> git    cluster <----------------------------
                       \    /   ^
                        \  /    | ArgoCD notices the drift and
                       ArgoCD --  reverts it back to match git
                    (continuous
                     reconciliation,
                     not just "on new
                     commit")
```

Our script only reacts to NEW commits - if you manually change something
in the live cluster without touching git, our script has no idea and
won't fix it. ArgoCD continuously compares live state to desired (git)
state and self-heals drift in either direction, which is the piece we're
deliberately not building here (see `k8s/README.md` for the full list of
gaps).
