#!/usr/bin/env bash
# Starts cloud-native-agent with Docker in one command.
#
#   ./scripts/up.sh              # edge + agent-1
#   ./scripts/up.sh --replicas   # edge + agent-1, agent-2 and agent-3 (ADR-0012)
#
# --no-build reuses the images already built; any other argument is passed to
# `docker compose up`.
# On the first run it creates deploy/compose/.env from .env.example with a fresh
# AGENT_API_TOKEN. The token is never printed: it stays in that file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/deploy/compose/docker-compose.yml"
ENV_FILE="$ROOT/deploy/compose/.env"
ENV_EXAMPLE="$ROOT/deploy/compose/.env.example"
ALL_REPLICAS="agent-1,agent-2,agent-3"
HEALTH_TIMEOUT_S="${CNA_UP_HEALTH_TIMEOUT_S:-120}"

die() {
  echo "up.sh: $*" >&2
  exit 1
}

new_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# Value of KEY in the .env file (last assignment wins, like compose); empty if missing.
env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'
}

replicas=false
build=(--build)
up_args=()
for arg in "$@"; do
  case "$arg" in
    --replicas) replicas=true ;;
    --no-build) build=() ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) up_args+=("$arg") ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "no encuentro docker; instala Docker (ver README, Requisitos)"
docker compose version >/dev/null 2>&1 || die "docker compose no está disponible (hace falta Compose v2)"
docker info >/dev/null 2>&1 || die "Docker no está arrancado (abre Docker Desktop o arranca el servicio docker)"

# 1. Configuration: .env with a token, created only when missing.
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$ENV_EXAMPLE" ] || die "falta $ENV_EXAMPLE"
  (umask 077 && cp "$ENV_EXAMPLE" "$ENV_FILE")
  echo "Creado deploy/compose/.env a partir de .env.example"
fi
chmod 600 "$ENV_FILE"
if [ -z "$(env_value AGENT_API_TOKEN)" ]; then
  token="$(new_token)"
  if grep -q '^AGENT_API_TOKEN=' "$ENV_FILE"; then
    tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    awk -v t="$token" '/^AGENT_API_TOKEN=/ { if (!done) { print "AGENT_API_TOKEN=" t; done = 1; next } } { print }' \
      "$ENV_FILE" >"$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '\nAGENT_API_TOKEN=%s\n' "$token" >>"$ENV_FILE"
  fi
  unset token
  echo "Generado AGENT_API_TOKEN en deploy/compose/.env"
fi
if [ ! -f "$ROOT/config/providers.yaml" ]; then
  echo "Aviso: no hay config/providers.yaml; se usan los proveedores integrados de Pi" \
    "(copia config/providers.example.yaml para configurar otros)."
fi

# 2. Build and start.
compose=(docker compose -f "$COMPOSE_FILE")
if [ "$replicas" = true ]; then
  compose+=(--profile replicas)
  # edge must know the replicas that are up; .env wins if it already says which ones.
  if [ -z "$(env_value CNA_REPLICAS)" ]; then
    export CNA_REPLICAS="$ALL_REPLICAS"
  fi
fi
"${compose[@]}" up ${build[@]+"${build[@]}"} -d ${up_args[@]+"${up_args[@]}"}

# 3. Wait for edge.
addr="$(env_value CNA_PUBLISH_ADDR)"
case "$addr" in
  "" | 0.0.0.0) host="127.0.0.1" ;;
  *) host="$addr" ;;
esac
url="http://$host:8080"
if command -v curl >/dev/null 2>&1; then
  deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  until curl -fsS -o /dev/null "$url/health" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      die "edge no responde en $url/health; mira los logs: docker compose -f deploy/compose/docker-compose.yml logs"
    fi
    sleep 2
  done
fi

cat <<EOF

cloud-native-agent en marcha.
  Web UI:  $url/ui/
  Token:   AGENT_API_TOKEN en deploy/compose/.env
  CLI:     CNA_URL=$url CNA_TOKEN=<token> npx cna replicas
  Parar:   docker compose -f deploy/compose/docker-compose.yml down
EOF
