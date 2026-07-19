# Rolling update: V1 -> V2

Starting point: 5 Pods, all running V1, all passing readinessProbe.

```
[V1] [V1] [V1] [V1] [V1]        <- Service routes to all 5
```

`kubectl set image deployment/api api=k8s-lab-api:v2` triggers a new
ReplicaSet. With `maxSurge: 1, maxUnavailable: 1`, Kubernetes creates one
new Pod before removing an old one:

```
[V1] [V1] [V1] [V1] [V1] [V2*]   <- V2* not yet Ready, Service ignores it
```

Once the new Pod's readinessProbe passes, Kubernetes tears down one old
Pod and repeats - never more than 1 extra, never more than 1 missing,
relative to the desired count of 5:

```
[V1] [V1] [V1] [V1] [V2]         <- one V1 replaced
[V1] [V1] [V1] [V2] [V2]
[V1] [V1] [V2] [V2] [V2]
[V1] [V2] [V2] [V2] [V2]
[V2] [V2] [V2] [V2] [V2]         <- done
```

Throughout the whole rollout, the Service always has at least 4 Ready
Pods to route to (never fewer than desired-maxUnavailable) - this is why
a rolling update causes no downtime for a healthy new image.

## What the readinessProbe is actually protecting you from

If V2 were broken (crashes, wrong port, bad env var), the very first new
Pod would never pass its readinessProbe. Kubernetes would then refuse to
terminate ANY more V1 Pods:

```
[V1] [V1] [V1] [V1] [V1] [V2-BROKEN, never Ready]
```

The rollout just hangs here (`kubectl rollout status` blocks, `kubectl
get pods` shows the broken Pod stuck at `0/1`) - all 5 original V1 Pods
keep serving traffic the whole time. `kubectl rollout undo` cleans up the
stuck rollout and removes the broken Pod.
