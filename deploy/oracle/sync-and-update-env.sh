#!/usr/bin/env bash
set -euo pipefail

VM_HOST="${VM_HOST:-ubuntu@144.24.109.107}"
SSH_KEY="${SSH_KEY:-$HOME/Downloads/ssh-key-2026-09-23.key}"
REMOTE_DIR="${REMOTE_DIR:-alpha-deploy/apps/core-backend}"
CONTAINER="${CONTAINER:-core-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:48900/health}"
LOCAL_BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../apps/core-backend" && pwd)"
LOCAL_ENV="${LOCAL_ENV:-$LOCAL_BACKEND/.env}"
ENV_KEYS=(RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_PLAN_INR RAZORPAY_WEBHOOK_SECRET)

SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o ServerAliveInterval=30)
SSH=(ssh "${SSH_OPTS[@]}" "$VM_HOST")

usage() {
    cat <<EOF
Usage: $(basename "$0") <command> [--yes]

Commands:
  diff      dry-run rsync of source files to the VM (changes nothing)
  sync      rsync changed source files to the VM
  env       merge the Razorpay keys from the local .env into the VM .env (backup first)
  restart   recreate the container from its current image so it reloads .env, rolling back if /health fails
  all       sync, env, restart

Environment overrides: VM_HOST SSH_KEY REMOTE_DIR CONTAINER HEALTH_URL LOCAL_ENV
EOF
}

confirm() {
    [[ "${ASSUME_YES:-0}" == 1 ]] && return 0
    read -r -p "$1 [y/N] " answer
    [[ "$answer" == [yY] ]]
}

RSYNC_ARGS=(
    -rc --itemize-changes
    --exclude target --exclude '.env*' --exclude .kesami --exclude 'meeting*' --exclude 'Kesami Meetings' --exclude '.kesami*' --exclude .DS_Store --exclude .claude
    --exclude src/bin --exclude Dockerfile.cloud --exclude .git
    -e "ssh -i $SSH_KEY -o IdentitiesOnly=yes"
)

do_diff() {
    rsync -n "${RSYNC_ARGS[@]}" "$LOCAL_BACKEND/" "$VM_HOST:$REMOTE_DIR/"
}

do_sync() {
    echo '--- files that would change'
    do_diff
    confirm 'Copy these files to the VM?' || { echo 'skipped sync'; return 0; }
    rsync "${RSYNC_ARGS[@]}" "$LOCAL_BACKEND/" "$VM_HOST:$REMOTE_DIR/"
}

local_value() {
    local name="$1" value
    value="$(grep -E "^(ALPHA|KESAMI)_${name}=" "$LOCAL_ENV" | tail -n1 | cut -d= -f2-)"
    value="${value%\"}"
    value="${value#\"}"
    printf '%s' "$value"
}

do_env() {
    [[ -f "$LOCAL_ENV" ]] || { echo "missing $LOCAL_ENV" >&2; exit 1; }
    local payload=""
    for key in "${ENV_KEYS[@]}"; do
        local value
        value="$(local_value "$key")"
        [[ -n "$value" ]] || { echo "no value for $key in $LOCAL_ENV" >&2; exit 1; }
        payload+="$key=$value"$'\n'
    done
    echo "keys to merge into $REMOTE_DIR/.env on the VM:"
    printf '  %s\n' "${ENV_KEYS[@]}"
    confirm 'Update the VM .env?' || { echo 'skipped env'; return 0; }

    local script
    IFS= read -r -d '' script <<'REMOTE' || true
set -euo pipefail
cd ~
[[ -f "$REMOTE_ENV" ]] || { echo "missing $REMOTE_ENV" >&2; exit 1; }
cp -p "$REMOTE_ENV" "$REMOTE_ENV.bak-$(date +%Y%m%d%H%M%S)"
tmp="$(mktemp)"
cp -p "$REMOTE_ENV" "$tmp"
new="$(cat <<'PAYLOAD'
__PAYLOAD__
PAYLOAD
)"
while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    name="${line%%=*}"
    value="${line#*=}"
    prefix=KESAMI
    grep -qE "^ALPHA_${name}=" "$tmp" && ! grep -qE "^KESAMI_${name}=" "$tmp" && prefix=ALPHA
    grep -vE "^(ALPHA|KESAMI)_${name}=" "$tmp" > "$tmp.next" || true
    printf '%s_%s=%s\n' "$prefix" "$name" "$value" >> "$tmp.next"
    mv "$tmp.next" "$tmp"
    echo "set ${prefix}_${name}"
done <<< "$new"
cat "$tmp" > "$REMOTE_ENV"
chmod 600 "$REMOTE_ENV"
rm -f "$tmp"
REMOTE
    script="${script//__PAYLOAD__/${payload%$'\n'}}"
    printf 'REMOTE_ENV=%q\n%s\n' "$REMOTE_DIR/.env" "$script" | "${SSH[@]}" bash -s
}

do_restart() {
    confirm "Recreate container $CONTAINER now (brief downtime, auto-rollback on failed health)?" || { echo 'skipped restart'; return 0; }
    "${SSH[@]}" "CONTAINER='$CONTAINER' REMOTE_ENV='$REMOTE_DIR/.env' HEALTH_URL='$HEALTH_URL' bash -s" <<'REMOTE'
set -euo pipefail
cd ~
image="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
data_mount="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$CONTAINER")"
[[ -n "$data_mount" ]] || { echo 'no /data mount found on the running container' >&2; exit 1; }
stamp="$(date +%Y%m%d%H%M%S)"
old="$CONTAINER-old-$stamp"

echo "env names the file provides:"
sed -E 's/=.*//' "$REMOTE_ENV" | grep -vE '^\s*(#|$)' | sort -u | sed 's/^/  /'

docker stop "$CONTAINER" >/dev/null
docker rename "$CONTAINER" "$old"
docker run -d --name "$CONTAINER" --restart unless-stopped \
    --env-file "$REMOTE_ENV" -v "$data_mount:/data" -p 127.0.0.1:48900:48900 "$image" >/dev/null

for _ in $(seq 1 60); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
        echo "healthy: $CONTAINER on $image (previous kept as $old)"
        exit 0
    fi
    sleep 2
done

echo 'health check failed, rolling back' >&2
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker rename "$old" "$CONTAINER"
docker start "$CONTAINER" >/dev/null
exit 1
REMOTE
}

cmd="${1:-}"
[[ "${2:-}" == "--yes" ]] && ASSUME_YES=1
case "$cmd" in
    diff) do_diff ;;
    sync) do_sync ;;
    env) do_env ;;
    restart) do_restart ;;
    all) do_sync; do_env; do_restart ;;
    *) usage; exit 1 ;;
esac
