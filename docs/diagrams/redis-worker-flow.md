# Redis + worker flow, end-to-end

```
 client                api Pod              redis Pod           worker Pod           postgres Pod
   |                      |                      |                    |                    |
   |-- POST /jobs ------->|                      |                    |                    |
   |                      |-- LPUSH "jobs" ----->|                    |                    |
   |<-- 201 queued -------|                      |                    |                    |
   |   (API returns immediately - it never waits for the job to finish)
   |                      |                      |<-- BRPOP "jobs" ---|                    |
   |                      |                      |-- job payload ---->|                    |
   |                      |                      |                    | (sleep 5s, simulates work)
   |                      |                      |                    |-- INSERT jobs ---->|
   |                      |                      |                    |   (status=completed)
```

## Why this proves something worth proving

- **The API and worker are decoupled.** `POST /jobs` returns in
  milliseconds regardless of how long the job actually takes to process -
  Redis is the buffer between "I want this done" and "this got done."
- **`BRPOP` blocks instead of polling.** The worker isn't checking Redis
  on a timer; it's asleep until Redis itself wakes it up the instant a job
  arrives. Watch `kubectl exec deployment/redis -- redis-cli LLEN jobs`
  right after posting a job - it often reads `0` already, because the
  worker grabbed it within milliseconds.
- **One worker replica means strictly sequential processing.** Post 3
  jobs in a burst and the queue length visibly drops one at a time (5s
  apart) as a single worker processes them one by one, in the order they
  were queued (Redis lists are FIFO with LPUSH/BRPOP). Running multiple
  worker replicas (just `kubectl scale deployment worker --replicas=3`)
  would let them drain concurrently instead - same code, no changes
  needed, because Redis coordinates which worker gets which job.

## Reproduce it yourself

```
kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LLEN jobs   # check queue is empty first

minikube service api -n local-k8s-lab --url
# in another terminal, using the printed URL:
for i in 1 2 3; do
  curl -s -X POST http://127.0.0.1:<port>/jobs -H "Content-Type: application/json" -d "{\"task\":\"burst-$i\"}"
done

# watch the queue drain one at a time, ~5s apart
watch -n1 'kubectl exec -n local-k8s-lab deployment/redis -- redis-cli LLEN jobs'

# in another terminal, watch it happen live
kubectl logs -f -n local-k8s-lab deployment/worker
```
