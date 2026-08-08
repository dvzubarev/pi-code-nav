#!/usr/bin/env bash
# Shared retry policy for flaky network operations.

readonly RETRY_MAX_ATTEMPTS=4
readonly RETRY_BACKOFF_SECONDS=2

with_retry() {
    local max_attempts="$1"
    shift
    local attempt=1
    until "$@"; do
        if (( attempt >= max_attempts )); then
            return 1
        fi
        sleep $((RETRY_BACKOFF_SECONDS * attempt))
        ((attempt++))
    done
}
