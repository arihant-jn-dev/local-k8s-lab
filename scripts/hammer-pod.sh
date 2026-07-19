#!/bin/sh
# Fires many requests at /pod and tallies which Pod name answered each one -
# visible proof that the Service load-balances across all replicas instead
# of always hitting the same Pod. Usage:
#   ./scripts/hammer-pod.sh <base-url> [request-count]
# Example:
#   ./scripts/hammer-pod.sh http://127.0.0.1:63914 50

set -eu

BASE_URL="${1:?Usage: hammer-pod.sh <base-url> [request-count]}"
COUNT="${2:-50}"

echo "Firing $COUNT requests at $BASE_URL/pod ..."

for i in $(seq 1 "$COUNT"); do
  curl -s "$BASE_URL/pod" | grep -o '"hostname":"[^"]*"'
done | sort | uniq -c | sort -rn
