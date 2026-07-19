# CI/CD flow: from push to running Pods

## Phase 9 - CI (GitHub Actions) - verifies the code

```
        git push / pull request
you -----------------------------> GitHub
                                       |
                                       v
                          .github/workflows/ci.yml
                                       |
                    +------------------+------------------+
                    v                                      v
              api job                                worker job
        checkout -> npm ci                       checkout -> npm ci
        -> npm test                               -> docker build
        -> docker build                           (no tests yet)
                    |                                      |
                    +------------------+------------------+
                                       v
                          pass/fail shown on the
                          commit / pull request
```

CI answers one question: **is this change good?** It never touches the
cluster - the Docker images it builds are thrown away when the job ends
(this project has no registry to push them to; see the disabled
"push to registry" step in `ci.yml` for what a real pipeline would do
here). If tests fail or the Docker build breaks, that shows up directly
on the commit/PR in GitHub - before anything gets anywhere near Minikube.

## Phase 8 - CD (simulated-cd.sh) - deploys verified manifest changes

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

## Putting CI and CD together

```
you --push--> GitHub --> CI (ci.yml): test + build, never deploys
                |
                | (in a REAL pipeline: push image, bump manifest tag)
                | (in THIS project: these two are manual/separate -
                |  see .github/workflows/README.md for why)
                v
        k8s/*.yaml committed --> CD (simulated-cd.sh): pulls + kubectl apply
                                        |
                                        v
                                    cluster
```

CI and CD answer different questions - "is this change good?" vs. "is
this change running?" - and this project deliberately keeps them as two
separate, independently-understandable pieces rather than one pipeline
that does everything, so each is simple enough to reason about on its
own.
