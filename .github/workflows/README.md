# .github/workflows/

## ci.yml

Runs on every push and pull request targeting `main`. Two jobs, one per
app:

- **api**: checkout -> install (`npm ci`) -> test (`npm test`, the
  `node --test` smoke tests in `api/index.test.js`) -> Docker build.
- **worker**: checkout -> install -> Docker build (no tests yet - the
  worker has no pure/stateless logic to unit test the way the API's
  `/health` and `/pod` routes do).

Both jobs build a Docker image to prove the Dockerfile still produces a
working image, but neither pushes it anywhere - this project has no real
container registry (see `k8s/README.md`; images get loaded straight into
Minikube instead). The workflow includes a disabled (`if: false`), heavily
commented "push to registry" step explaining what that step would do in
a real production pipeline (tag with the commit SHA, push to
GHCR/Docker Hub/ECR, then let a CD step update a manifest and roll it
out) - kept as documentation rather than deleted.

## How this connects to Phase 8's simulated CD

This workflow is CI (verify the code is good) - it stops after building
an image. `scripts/simulated-cd.sh` is CD (deploy verified code) - it
watches for committed changes to `k8s/` and applies them. In a real
production setup, a CI job like this one would end by pushing a new
image and updating a manifest's image tag, which would then trigger the
CD side. We keep them deliberately separate and manual-in-the-middle
here (nothing here rebuilds Minikube's images automatically) so each
piece stays simple enough to understand in isolation.
