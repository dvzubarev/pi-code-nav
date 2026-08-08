#!/usr/bin/env bash
# Structured logging helpers shared by deployment jobs.

readonly LOG_COMPONENT="release"

log_event() {
    local level="$1"
    local message="$2"
    printf '[%s] %s: %s\n' "$level" "$LOG_COMPONENT" "$message" >&2
}

log_info() {
    log_event INFO "$1"
}

log_error() {
    log_event ERROR "$1"
}
