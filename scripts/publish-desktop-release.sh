#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $0 <tag> <workflow-run-id>" >&2
    echo "Example: $0 v1.0.4 37680546425" >&2
}

if [[ $# -ne 2 || ! $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ || ! $2 =~ ^[0-9]+$ ]]; then
    usage
    exit 2
fi

tag=$1
run_id=$2
source_repo=${KESAMI_SOURCE_REPO:-xenxorowdy/meeting-app}
release_repo=${KESAMI_RELEASE_REPO:-xenxorowdy/kesami-releases}

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
gh auth status --hostname github.com >/dev/null

run_json=$(gh run view "$run_id" --repo "$source_repo" --json headBranch,event,jobs)
run_branch=$(jq -r '.headBranch' <<<"$run_json")
run_event=$(jq -r '.event' <<<"$run_json")
if [[ $run_branch != "$tag" || $run_event != push ]]; then
    echo "Run $run_id is not a tag-push build for $tag (branch=$run_branch, event=$run_event)" >&2
    exit 1
fi

for platform in mac windows; do
    result=$(jq -r --arg platform "$platform" '[.jobs[] | select(.name == $platform) | .conclusion] | if length == 1 then .[0] else "missing" end' <<<"$run_json")
    if [[ $result != success ]]; then
        echo "The $platform build for $tag did not succeed (result=$result)" >&2
        exit 1
    fi
done

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/kesami-release.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT
gh run download "$run_id" --repo "$source_repo" --dir "$tmp_dir/artifacts"

files=(
    "$tmp_dir/artifacts/mac/Kesami-arm64.dmg"
    "$tmp_dir/artifacts/mac/latest-mac.yml"
    "$tmp_dir/artifacts/windows/Kesami-Setup-x64.exe"
    "$tmp_dir/artifacts/windows/latest.yml"
)
mac_zip=$(find "$tmp_dir/artifacts/mac" -maxdepth 1 -type f -name 'Kesami-*-arm64-mac.zip' -print -quit)
if [[ -n $mac_zip ]]; then files+=("$mac_zip"); fi
for required in "${files[@]}"; do
    if [[ ! -f $required ]]; then
        echo "Expected release artifact is missing: $required" >&2
        find "$tmp_dir/artifacts" -maxdepth 3 -type f -print >&2
        exit 1
    fi
done

for platform_dir in mac windows; do
    while IFS= read -r -d '' file; do files+=("$file"); done \
        < <(find "$tmp_dir/artifacts/$platform_dir" -maxdepth 1 -type f \
            -name '*.blockmap' -print0)
done

notes=$(cat <<'NOTES'
### macOS

Download **Kesami-arm64.dmg**, open it, and drag Kesami into Applications. Requires an Apple Silicon Mac with macOS 13 or later.

This build is unsigned and not notarized by Apple, so macOS may block the first launch. If you trust Kesami, open System Settings → Privacy & Security and click **Open Anyway**.

### Windows

Download **Kesami-Setup-x64.exe** and run it. It installs Kesami for your user account, with no administrator prompt. Requires 64-bit Windows 10 or 11.

This installer is not code-signed, so Microsoft Defender SmartScreen may show **Windows protected your PC**. If you trust Kesami, click **More info**, then **Run anyway**.
NOTES
)

if gh release view "$tag" --repo "$release_repo" >/dev/null 2>&1; then
    gh release upload "$tag" --repo "$release_repo" "${files[@]}" --clobber
    gh release edit "$tag" --repo "$release_repo" --title "Kesami $tag" --notes "$notes"
else
    gh release create "$tag" --repo "$release_repo" "${files[@]}" \
        --title "Kesami $tag" --notes "$notes"
fi

gh release view "$tag" --repo "$release_repo" --json url,assets \
    --jq '{url, assets: [.assets[].name]}'
