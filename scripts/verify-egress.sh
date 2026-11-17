#!/usr/bin/env bash
# verify-egress.sh: checks that every toolchain in the agent container reaches the internet
# only through the edge proxy, and summarizes the hosts it connected to (base for the
# phase 1 allowlist). Run it from the repository root with the stack already up.
#
# Usage:
#   docker compose -f deploy/compose/docker-compose.yml up -d
#   scripts/verify-egress.sh
#   COMPOSE_FILE_PATH=other/compose.yml scripts/verify-egress.sh   # optional
#
# Exit codes: 0 all checks pass, 1 at least one check failed, 2 services not running.
# Secrets: this script never prints environment variables. GITHUB_TOKEN is only tested
# for emptiness inside the container.
set -uo pipefail
# No -e: every check is evaluated on its own.

COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-deploy/compose/docker-compose.yml}"
WORK_DIR="/data/cache/verify-egress"

checks=0
failures=0

in_agent() {
  docker compose -f "$COMPOSE_FILE_PATH" exec -T agent-1 bash -c "$1"
}

in_edge() {
  docker compose -f "$COMPOSE_FILE_PATH" exec -T edge sh -c "$1"
}

# check <name> <command>: runs the command inside the agent (as its default user) with a
# 300 s timeout. PASS if it exits 0; otherwise FAIL with the last 20 lines of output.
# Checks that must fail encode that in the command itself (e.g. `! curl ...`).
check() {
  local name="$1" cmd="$2" out rc
  checks=$((checks + 1))
  out="$(mktemp)"
  in_agent "timeout 300 bash -c $(printf '%q' "$cmd")" >"$out" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s (exit %s)\n' "$name" "$rc"
    tail -n 20 "$out" | sed 's/^/    /'
    failures=$((failures + 1))
  fi
  rm -f "$out"
}

# 0. Services must be running.
running="$(docker compose -f "$COMPOSE_FILE_PATH" ps --status running --services 2>/dev/null)"
for svc in agent-1 edge; do
  if ! printf '%s\n' "$running" | grep -qx "$svc"; then
    echo "Service '$svc' is not running. Start the stack with:" >&2
    echo "  docker compose -f $COMPOSE_FILE_PATH up -d" >&2
    exit 2
  fi
done

# Mark the current end of network.jsonl so the summary only covers this run.
mark="$(in_edge 'if [ -f /edge-data/network.jsonl ]; then wc -l < /edge-data/network.jsonl; else echo 0; fi' | tr -dc '0-9')"
mark="${mark:-0}"

in_agent "rm -rf $WORK_DIR && mkdir -p $WORK_DIR" >/dev/null 2>&1

# 1. Direct egress must fail: the agent has no route outside the proxy.
check "no-direct-egress" \
  "command -v curl >/dev/null && ! curl -sS --max-time 10 --noproxy '*' https://github.com -o /dev/null"

# 2. Proxy environment variables.
check "proxy-env" \
  '[ "$HTTPS_PROXY" = "http://edge:3128" ] && [ "$NODE_USE_ENV_PROXY" = "1" ]'

# 3. curl through the proxy.
check "curl-via-proxy" \
  "curl -fsS --max-time 20 https://api.github.com/zen -o /dev/null"

# 4. git over HTTPS.
check "git" \
  "git ls-remote https://github.com/git/git HEAD"

# 5. gh: only when a token is configured. The token is never printed.
if in_agent '[ -n "$GITHUB_TOKEN" ]' >/dev/null 2>&1; then
  check "gh" "gh api rate_limit --jq .rate.limit"
else
  echo "SKIP gh (GITHUB_TOKEN not set)"
fi

# 6. Pi.
check "pi" "pi --version"

# 7. Node fetch (needs NODE_USE_ENV_PROXY=1).
check "node-fetch" \
  'node -e "fetch(\"https://registry.npmjs.org/typescript/latest\").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"'

# 8. npm.
check "npm" "npm view typescript version"

# 9. pnpm.
check "pnpm" "pnpm view typescript version"

# 10. pip.
check "pip" "python -m pip download --no-deps -d $WORK_DIR/pip six"

# 11. uv.
check "uv" "cd $WORK_DIR && uv venv -q uvenv && VIRTUAL_ENV=uvenv uv pip install -q six"

# 12. Maven.
check "maven" "mvn -q -B dependency:get -Dartifact=junit:junit:4.13.2"

# 13. Gradle: dependency resolution from Maven Central.
check "gradle" "mkdir -p $WORK_DIR/gradle && cd $WORK_DIR/gradle \
&& : > settings.gradle \
&& printf '%s\n' \"plugins { id 'java' }\" \"repositories { mavenCentral() }\" \
\"dependencies { implementation 'com.google.code.gson:gson:2.11.0' }\" > build.gradle \
&& gradle -q dependencies --configuration runtimeClasspath"

# 14. Gradle: plugin resolution from the Gradle Plugin Portal.
check "gradle-plugin-portal" "mkdir -p $WORK_DIR/gradle-plugin && cd $WORK_DIR/gradle-plugin \
&& : > settings.gradle \
&& printf '%s\n' \"plugins { id 'com.github.ben-manes.versions' version '0.51.0' }\" > build.gradle \
&& gradle -q help"

# 15. Go modules through proxy.golang.org and sum.golang.org.
check "go" "mkdir -p $WORK_DIR/go && cd $WORK_DIR/go \
&& go mod init example.com/verify \
&& go get golang.org/x/text@v0.21.0"

# 16. mise.
check "mise-ls-remote" "[ -n \"\$(mise ls-remote node 22 | tail -1)\" ]"

# 17. Toolchain download hosts. Any HTTP status counts (403/404 still means the network
# works); only 000 (no connection) fails.
toolchain_hosts="
https://services.gradle.org/distributions/
https://downloads.gradle.org/
https://nodejs.org/dist/index.json
https://go.dev/dl/?mode=json
https://dl.google.com/go/
https://api.adoptium.net/v3/info/available_releases
https://mise.jdx.dev/
"
for url in $toolchain_hosts; do
  host="${url#https://}"
  host="${host%%/*}"
  check "toolchain:$host" \
    "[ \"\$(curl -sS --max-time 20 -I -o /dev/null -w '%{http_code}' '$url')\" != 000 ]"
done

# 18. Internal destinations must be denied by the proxy (HTTP 403).
check "internal-denied" \
  "[ \"\$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' http://169.254.169.254/)\" = 403 ]"

# Cleanup of the agent working directory.
in_agent "rm -rf $WORK_DIR" >/dev/null 2>&1

# Network summary: hosts seen by edge since the mark, deduplicated.
echo
echo "Network summary (new lines in network.jsonl since this run started)"
echo "This list is the base for closing the phase 1 allowlist."
echo

new_lines="$(mktemp)"
in_edge "tail -n +$((mark + 1)) /edge-data/network.jsonl 2>/dev/null" >"$new_lines" 2>/dev/null || true

keys="$(mktemp)"
if [ ! -s "$new_lines" ]; then
  : # no new connections
elif command -v node >/dev/null 2>&1; then
  node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      console.log(`${entry.host}:${entry.port} ${entry.decision} ${entry.reason}`);
    }
  ' <"$new_lines" >"$keys"
elif command -v jq >/dev/null 2>&1; then
  jq -Rr 'fromjson? | select(. != null) | "\(.host):\(.port) \(.decision) \(.reason)"' \
    <"$new_lines" >"$keys"
else
  echo "Neither node nor jq found on the host; raw network.jsonl lines:" >&2
  cat "$new_lines"
fi

if [ -s "$keys" ]; then
  printf '%-45s %-8s %-22s %s\n' "host:port" "decision" "reason" "count"
  sort "$keys" | uniq -c | sort -k2,2 | awk '
    {
      count = $1
      $1 = ""
      sub(/^ +/, "")
      n = split($0, f, " ")
      printf "%-45s %-8s %-22s %d\n", f[1], f[2], f[3], count
    }'
elif [ ! -s "$new_lines" ]; then
  echo "No new connections recorded by edge."
fi
rm -f "$new_lines" "$keys"

echo
printf '%d checks, %d failed\n' "$checks" "$failures"
if [ "$failures" -gt 0 ]; then
  exit 1
fi
exit 0
