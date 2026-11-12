#!/usr/bin/env bash
# scripts/bg.sh — run the long-lived processes in the background, so they survive a closed
# terminal tab (handy from a phone browser, e.g. GitHub Codespaces).
#
#   ./scripts/bg.sh start receiver|poller|reconcile|snapshot
#   ./scripts/bg.sh stop  receiver|poller|reconcile|snapshot     (SIGTERM: the receiver records its stop time)
#   ./scripts/bg.sh status
#   ./scripts/bg.sh logs  receiver|poller|reconcile|snapshot     (last 20 lines)
#
# Output goes to logs/<name>.log, the PID to run/<name>.pid.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs run

cmd_for() {
  case "$1" in
    receiver)  echo "node receiver.js" ;;
    poller)    echo "node poll.js --every 60" ;;          # the experiment's 60-second interval
    reconcile) echo "node reconcile.js --every 3600" ;;   # hourly catch-up job
    snapshot)  echo "node snapshot-pending.js --every 300" ;;  # outage only: Stripe's pending view every 5 min
    *) echo "unknown process '$1' (receiver|poller|reconcile|snapshot)" >&2; exit 2 ;;
  esac
}
alive() { [[ -f "run/$1.pid" ]] && kill -0 "$(cat "run/$1.pid")" 2>/dev/null; }

case "${1:-status}" in
  start)
    name="${2:?which process?}"; cmd="$(cmd_for "$name")"
    if alive "$name"; then echo "$name already running (pid $(cat "run/$name.pid"))"; exit 0; fi
    # setsid + nohup: not tied to this terminal. exec: the PID file holds node's own PID.
    setsid nohup bash -c "exec $cmd" >> "logs/$name.log" 2>&1 < /dev/null &
    echo $! > "run/$name.pid"
    sleep 1
    if alive "$name"; then echo "started $name (pid $(cat "run/$name.pid")): $cmd"; tail -n 3 "logs/$name.log"
    else echo "$name exited at once. Last log lines:"; tail -n 10 "logs/$name.log"; rm -f "run/$name.pid"; exit 1; fi
    ;;
  stop)
    name="${2:?which process?}"
    if ! alive "$name"; then echo "$name is not running"; rm -f "run/$name.pid"; exit 0; fi
    kill -TERM "$(cat "run/$name.pid")"
    for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$name" || break; sleep 0.5; done
    if alive "$name"; then echo "$name did not stop; still pid $(cat "run/$name.pid")"; exit 1; fi
    rm -f "run/$name.pid"; echo "stopped $name"; tail -n 2 "logs/$name.log"
    ;;
  status)
    for n in receiver poller reconcile snapshot; do
      if alive "$n"; then echo "$n: running (pid $(cat "run/$n.pid"))"; else echo "$n: stopped"; fi
    done
    ;;
  logs)
    tail -n 20 "logs/${2:?which process?}.log"
    ;;
  *) echo "usage: $0 start|stop|status|logs [receiver|poller|reconcile|snapshot]" >&2; exit 2 ;;
esac
