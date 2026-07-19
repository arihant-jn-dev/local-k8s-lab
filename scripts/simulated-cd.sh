#!/bin/sh
# A tiny stand-in for what ArgoCD (or any GitOps tool) does in production:
#   1. Git is the source of truth - not your local kubectl commands.
#   2. A controller continuously watches the repo for new commits.
#   3. When the tracked manifests change, it automatically re-applies them
#      to the cluster - no human runs `kubectl apply` by hand.
#
# This script polls the given branch every $POLL_INTERVAL_SECONDS. If the
# remote has new commits AND any file under k8s/ changed between the last
# applied commit and the new one, it pulls and applies. This is obviously
# much simpler than ArgoCD (no UI, no drift-detection/self-healing if
# someone kubectl-edits the cluster directly, no rollback UI) - but the
# core sync LOOP concept is the same one ArgoCD is built around.
#
# Usage: ./scripts/simulated-cd.sh [branch] [poll-interval-seconds]
# Example: ./scripts/simulated-cd.sh main 15

set -eu

BRANCH="${1:-main}"
POLL_INTERVAL_SECONDS="${2:-15}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$REPO_ROOT/.simulated-cd-last-applied-commit"

cd "$REPO_ROOT"

log() {
  # Every line is timestamped so the sync loop's log reads like a real
  # deployment history - important once you're debugging "when did this
  # actually roll out."
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "Simulated CD started - watching branch '$BRANCH', polling every ${POLL_INTERVAL_SECONDS}s"
log "Applying manifests from: $REPO_ROOT/k8s/"

# On first run, treat "whatever commit we're on right now" as already
# applied - otherwise the very first poll would always trigger an apply,
# even if nothing changed since you last ran this script.
if [ ! -f "$STATE_FILE" ]; then
  git rev-parse HEAD > "$STATE_FILE"
  log "No prior state found - recording current commit as baseline: $(cat "$STATE_FILE")"
fi

while true; do
  git fetch origin "$BRANCH" --quiet

  LAST_APPLIED="$(cat "$STATE_FILE")"
  REMOTE_HEAD="$(git rev-parse "origin/$BRANCH")"

  if [ "$LAST_APPLIED" = "$REMOTE_HEAD" ]; then
    log "No new commits on origin/$BRANCH - nothing to do"
  else
    # Only redeploy if the manifests we actually apply changed - a commit
    # that only touches docs/ or api/ source shouldn't trigger a
    # kubectl apply, the same way changing a app's source code alone
    # doesn't get redeployed until its image is rebuilt and referenced
    # from a manifest change.
    CHANGED_FILES="$(git diff --name-only "$LAST_APPLIED" "$REMOTE_HEAD" -- k8s/)"

    if [ -z "$CHANGED_FILES" ]; then
      log "New commits found, but no k8s/ changes - skipping apply, updating baseline"
    else
      log "k8s/ changes detected since last applied commit:"
      echo "$CHANGED_FILES" | sed 's/^/    /'

      log "Pulling latest $BRANCH..."
      git merge --ff-only "origin/$BRANCH"

      log "Applying k8s/ manifests..."
      kubectl apply -f k8s/

      log "Deploy complete."
    fi

    echo "$REMOTE_HEAD" > "$STATE_FILE"
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done
