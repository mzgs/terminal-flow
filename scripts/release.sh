#!/bin/sh
set -eu
set +x
cd "$(dirname "$0")/.."

fail() { printf '%s\n' "$*" >&2; exit 1; }
case "${1:-}" in
  ''|--dry-run) ;;
  *) fail "Usage: $0 [--dry-run]" ;;
esac
[ "$#" -le 1 ] || fail "Usage: $0 [--dry-run]"
for tool in git curl jq; do
  command -v "$tool" >/dev/null || fail "Install $tool first"
done

# Read the existing token without printing it or putting it in process arguments.
remote=$(git config --local --get remote.origin.url)
case "$remote" in
  https://*@github.com/*/*) ;;
  *) fail "origin must be an HTTPS GitHub URL with a token in .git/config" ;;
esac
auth=${remote#https://}
auth=${auth%%@*}
token=${auth#*:}
case "$token" in
  ''|*[!A-Za-z0-9_]*) fail "Invalid GitHub token in .git/config" ;;
esac
repo=${remote##*@github.com/}
repo=${repo%.git}
printf '%s\n' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fail "Invalid GitHub repository"
api() {
  endpoint=$1
  if [ "$#" -gt 1 ]; then set -- --data "$2"; else set --; fi
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl --config - --fail --silent --show-error --connect-timeout 10 --max-time 60 \
      -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2026-03-10' \
      -H 'Content-Type: application/json' "https://api.github.com/repos/$repo/$endpoint" "$@"
}

branch=$(git symbolic-ref --quiet --short HEAD) || fail "Check out a branch first"
sha=$(git rev-parse HEAD)
encoded_branch=$(printf '%s' "$branch" | jq -sRr @uri)
remote_commit=$(api "commits/$encoded_branch")
remote_sha=$(printf '%s' "$remote_commit" | jq -r .sha)
[ "$remote_sha" = "$sha" ] || fail "Push the current branch before releasing"
version=$(awk '/^\[package\]/{package=1;next} /^\[/{package=0} package && /^version *=/{split($0,parts,"\"");print parts[2];exit}' Cargo.toml)
refs=$(api git/matching-refs/tags/v)
tag=$(printf '%s' "$refs" | jq -r --arg version "$version" '
  ($version | split(".") | map(tonumber)) as $base |
  [.[].ref | select(test("^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$")) |
    ltrimstr("refs/tags/v") | split(".") | map(tonumber)] | max as $last |
  (if $last != null and $last >= $base then $last[:2] + [$last[2] + 1] else $base end) |
  "v" + (map(tostring) | join("."))')
printf '%s: %s from %s (%s)\n' "$repo" "$tag" "$branch" "$sha"
[ "${1:-}" != --dry-run ] || exit 0
[ -z "$(git status --porcelain)" ] || fail "Commit and push your changes before releasing"
payload=$(jq -nc --arg ref "$branch" --arg tag "$tag" --arg sha "$sha" '{ref:$ref,inputs:{tag:$tag,sha:$sha}}')
api actions/workflows/release.yml/dispatches "$payload" >/dev/null
printf 'Release builds started: https://github.com/%s/actions/workflows/release.yml\n' "$repo"
