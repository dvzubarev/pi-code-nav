#!/usr/bin/env bash
# Release deployment entry point used by CI and local operators.
set -euo pipefail

source "lib/logging.sh"
source "lib/retry.sh"

readonly RELEASE_LOCK="/var/lock/acme-release.lock"
DEPLOY_ENV="${DEPLOY_ENV:-staging}"

artifact_path() {
    local release_id="$1"
    printf 'artifacts/%s.tar.gz\n' "$release_id"
}

validate_artifact() {
    local artifact="$1"
    [[ -s "$artifact" ]] || {
        log_error "artifact is empty: $artifact"
        return 1
    }
}

upload_artifact() {
    local artifact="$1"
    log_info "uploading $artifact to $DEPLOY_ENV"
    # The real pipeline invokes the cloud CLI here.
    cloud_upload "$artifact" "$DEPLOY_ENV"
}

deploy_release() {
    local release_id="$1"
    local artifact
    artifact="$(artifact_path "$release_id")"
    validate_artifact "$artifact"
    with_retry "$RETRY_MAX_ATTEMPTS" upload_artifact "$artifact"
    log_info "release deployed: $release_id"
}

main() {
    local release_id="${1:?release id is required}"
    mkdir -p "$(dirname "$RELEASE_LOCK")"
    deploy_release "$release_id"
}

main "$@"
