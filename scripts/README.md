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
