#!/usr/bin/env bash
# Samples the CI Postgres service's client connections while the test steps run,
# and attributes each one to the workspace package whose process holds it.
#
#   ci-pg-connection-sampler.sh start <outfile>   # background loop, ~2 samples/s
#   ci-pg-connection-sampler.sh report <outfile>  # peak, per-package peaks, timeline
#
# Why this exists: the Unit Tests job has hit Postgres's max_connections
# ("sorry, too many clients already", SQLSTATE 53300) and the failures showed up
# as missing rows in billing-adjacent integration tests. A green run proves
# nothing about a load-dependent limit — this makes the margin visible on every
# run instead.
#
# Attribution uses the CLIENT side of each socket: `ss -tnp` on the runner maps
# every established connection to :5432 to the pid that owns it, and that pid's
# cwd is the package directory vitest/turbo launched it from. The server-side
# count (pg_stat_activity) is recorded alongside as the authoritative total.
set -u

mode="${1:?usage: start|report <outfile>}"
out="${2:?usage: start|report <outfile>}"

case "$mode" in
  start)
    : > "$out"
    while true; do
      ts="$(date -u +%H:%M:%S.%N | cut -c1-12)"
      server="$(PGPASSWORD=postgres PGCONNECT_TIMEOUT=2 psql -h localhost -U postgres -d postgres -Atc \
        "select count(*) from pg_stat_activity where backend_type = 'client backend'" 2>/dev/null || echo FULL)"
      by_pkg="$(sudo ss -Htnp state established '( dport = :5432 )' 2>/dev/null \
        | grep -o 'pid=[0-9]*' | cut -d= -f2 \
        | while read -r pid; do
            cwd="$(sudo readlink "/proc/$pid/cwd" 2>/dev/null || echo '?')"
            echo "${cwd#"$GITHUB_WORKSPACE"/}"
          done | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
      echo "$ts server=$server $by_pkg" >> "$out"
      sleep 0.5
    done
    ;;
  report)
    if [ ! -s "$out" ]; then
      echo "no samples in $out"
      exit 0
    fi
    samples="$(wc -l < "$out")"
    full="$(grep -c 'server=FULL' "$out" || true)"
    peak_line="$(grep -v 'server=FULL' "$out" | sort -t= -k2 -n | tail -1)"
    peak="$(echo "$peak_line" | sed -E 's/.*server=([0-9]+).*/\1/')"
    max_conn="$(PGPASSWORD=postgres psql -h localhost -U postgres -d postgres -Atc 'show max_connections' 2>/dev/null || echo '?')"
    echo "samples: $samples   max_connections: $max_conn   peak client backends: $peak   samples where the sampler itself could not connect: $full"
    echo "peak sample: $peak_line"
    echo
    echo "per-package peak (client sockets held at once):"
    tr ' ' '\n' < "$out" | grep '=' | grep -v -E '^server=' \
      | awk -F= '{ if ($2 > m[$1]) m[$1] = $2 } END { for (k in m) printf "  %4d  %s\n", m[k], k }' \
      | sort -rn
    echo
    echo "10 busiest samples:"
    grep -v 'server=FULL' "$out" | sort -t= -k2 -n | tail -10
    echo
    echo "timeline (every 20th sample):"
    awk 'NR % 20 == 1' "$out"
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 2
    ;;
esac
