#!/bin/sh
set -eu

engine=${OMEGA_SANDBOX_ENGINE:-}
if [ -z "$engine" ]; then
  if command -v docker >/dev/null 2>&1; then
    engine=docker
  elif command -v podman >/dev/null 2>&1; then
    engine=podman
  else
    printf '%s\n' 'omega: Docker or Podman is required to build the sandbox image' >&2
    exit 1
  fi
fi

exec "$engine" build --file Containerfile --tag omega-runner:local .
