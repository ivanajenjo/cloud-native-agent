#!/bin/sh
# Prepares the /data volume before starting the main process (gateway).
# Does not print environment variables: they may contain secrets.
set -eu

gradle_home="${GRADLE_USER_HOME:-/data/cache/gradle}"

mkdir -p /data/workspace /data/sessions /data/cache /data/config /data/logs "$gradle_home"

if [ ! -f "$gradle_home/gradle.properties" ] && [ -f /etc/cna/gradle.properties ]; then
  cp /etc/cna/gradle.properties "$gradle_home/gradle.properties"
fi

exec "$@"
