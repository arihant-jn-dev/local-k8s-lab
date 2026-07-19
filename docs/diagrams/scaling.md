# Scaling: one Deployment, many Pods, one Service

```
kubectl scale deployment api --replicas=5

                    Service "api" (ClusterIP)
                    selects Pods by label app=api
                            |
       -------------------------------------------------
       |          |          |          |          |
       v          v          v          v          v
   Pod api-1  Pod api-2  Pod api-3  Pod api-4  Pod api-5
   (app=api)  (app=api)  (app=api)  (app=api)  (app=api)
```

The Deployment's ReplicaSet is the thing that actually creates/destroys
Pods to match the replica count. The Service never changes - it just
watches for Pods matching its label selector and load-balances across
whichever ones currently exist and are Ready.

This is why `/pod` returning a different Pod name on every other request
proves load-balancing: each request goes to the Service, which round-robins
(roughly) across all 5 backing Pods, and each Pod reports its own hostname
(= Pod name) back.

Scaling down works the same way in reverse - the ReplicaSet terminates
Pods down to the new target count, and the Service immediately stops
routing to any Pod that's gone.
