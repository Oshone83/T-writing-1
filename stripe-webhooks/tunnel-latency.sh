#!/usr/bin/env bash
# tunnel-latency.sh: how much of the webhook delay is the tunnel, not Stripe.
# Sends 20 POSTs to the receiver through the tunnel and 20 straight to localhost, prints both medians.
# The receiver answers 400 (no signature); that's fine, only the round-trip time matters.
# Usage: ./tunnel-latency.sh https://your-tunnel.example.com [runs=20]
set -euo pipefail
TUNNEL="${1:?usage: $0 <tunnel base URL> [runs]}"
RUNS="${2:-20}"
PATHNAME=/webhooks/stripe

measure() {
  for _ in $(seq "$RUNS"); do
    curl -s -o /dev/null -w '%{time_total}\n' -X POST -H 'content-type: application/json' -d '{}' "$1"
  done | sort -n | awk '{a[NR]=$1} END {m = (NR % 2) ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2; printf "%.3f", m}'
}

t=$(measure "${TUNNEL%/}$PATHNAME")
l=$(measure "http://localhost:3000$PATHNAME")
echo "median over $RUNS runs: tunnel ${t} s, localhost ${l} s, tunnel adds $(awk -v a="$t" -v b="$l" 'BEGIN{printf "%.3f", a-b}') s"
