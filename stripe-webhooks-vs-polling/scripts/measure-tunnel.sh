#!/usr/bin/env bash
# measure-tunnel.sh — how much of the webhook delay is the tunnel, not Stripe.
# Times 20 POSTs to the tunnel URL and 20 to localhost, prints the median of each and the difference.
# The receiver must be running. The POSTs carry no signature, so they get a fast 400: that's fine,
# we're timing the round trip, not the handler.
#
#   ./scripts/measure-tunnel.sh https://your-tunnel.example.com
set -euo pipefail
TUNNEL="${1:?usage: $0 https://<your-tunnel-host>}"
LOCAL="http://localhost:${PORT:-3000}"
RUNS="${RUNS:-20}"

median() { sort -n | awk '{a[NR]=$1} END {print (NR%2 ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}'; }
measure() {
  for _ in $(seq "$RUNS"); do
    curl -s -o /dev/null -w '%{time_total}\n' -X POST -H 'content-type: application/json' -d '{}' "$1/webhooks/stripe"
  done
}

echo "timing $RUNS POSTs each..."
t=$(measure "$TUNNEL" | tee /dev/stderr | median)
l=$(measure "$LOCAL" | median)
echo "median via tunnel:    ${t}s"
echo "median via localhost: ${l}s"
awk -v t="$t" -v l="$l" 'BEGIN { printf "tunnel adds about:    %.3fs per request\n", t - l }'
