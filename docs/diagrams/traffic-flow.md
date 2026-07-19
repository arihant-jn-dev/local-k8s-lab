# Traffic flow: Service vs. Ingress

## Phase 3 - reaching a Pod via a Service (NodePort)

```
 your host                Minikube VM
+----------+          +--------------------------+
| curl /   | -------> | NodePort :30800          |
| browser  |          |   |                      |
+----------+          |   v                      |
                       | Service "api" (ClusterIP)|
                       |   | selects pods by label|
                       |   v                      |
                       | Pod api-xxxx (:3000)     |
                       +--------------------------+
```

A Service only gives you a raw port number - no hostnames, no path-based
routing. Fine for one app, awkward once you have several.

## Phase 4 - reaching a Pod via Ingress

```
 your host                          Minikube VM
+-----------------+          +---------------------------------+
| curl             |          | ingress-nginx-controller Pod    |
| Host: app.local | -------> | (reads Ingress rules)            |
+-----------------+          |   |                               |
                              |   v  matches host "app.local"    |
                              | Service "api" (ClusterIP)         |
                              |   |                               |
                              |   v                               |
                              | Pod api-xxxx (:3000)              |
                              +---------------------------------+
```

The Ingress Controller is itself just a Pod (running NGINX) that watches
the Kubernetes API for Ingress objects and reconfigures itself whenever
they change. The Ingress *resource* is just a declarative rule; the
*controller* is what actually proxies traffic according to that rule -
you need both, which is why `minikube addons enable ingress` (installs
the controller) is a separate step from `kubectl apply -f 09-ingress.yaml`
(creates the rule).

With multiple hostnames/paths, one Ingress Controller can route to many
different Services - this is the piece that lets a cluster serve several
apps behind one entry point, instead of a separate NodePort per app.
