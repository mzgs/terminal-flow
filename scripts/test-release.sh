#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
RELEASE_TEST_DIR=$(mktemp -d)
export RELEASE_TEST_DIR
trap 'rm -rf "$RELEASE_TEST_DIR"' EXIT HUP INT TERM
mkdir "$RELEASE_TEST_DIR/bin"
cat > "$RELEASE_TEST_DIR/bin/git" <<'SH'
#!/bin/sh
case "$1" in
  config) printf '%s\n' "${TEST_REMOTE:-https://user:test_token@github.com/owner/repo.git}" ;;
  symbolic-ref) echo feature/release ;;
  rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  status) printf '%s' "${TEST_DIRTY:-}" ;;
  *) exit 1 ;;
esac
SH
cat > "$RELEASE_TEST_DIR/bin/curl" <<'SH'
#!/bin/sh
set -eu
IFS= read -r config
[ "$config" = 'header = "Authorization: Bearer test_token"' ]
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url=$1 ;;
    --data) shift; printf '%s' "$1" > "$RELEASE_TEST_DIR/post" ;;
  esac
  shift
done
[ "${TEST_HTTP_ERROR:-}" != yes ] || exit 22
case "$url" in
  */commits/feature%2Frelease) printf '{"sha":"%s"}' "${TEST_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" ;;
  */git/matching-refs/tags/v)
    [ "${TEST_HTTP_ERROR:-}" != tags ] || exit 22
    echo '[{"ref":"refs/tags/v0.1.9"},{"ref":"refs/tags/v0.1.10"},{"ref":"refs/tags/v8.0.0-beta"}]' ;;
  */actions/workflows/release.yml/dispatches) ;;
  *) exit 1 ;;
esac
SH
chmod +x "$RELEASE_TEST_DIR/bin/git" "$RELEASE_TEST_DIR/bin/curl"
PATH="$RELEASE_TEST_DIR/bin:$PATH"
export PATH

sh scripts/release.sh --dry-run > "$RELEASE_TEST_DIR/output"
grep -q 'v0.1.11 from feature/release' "$RELEASE_TEST_DIR/output"
[ ! -f "$RELEASE_TEST_DIR/post" ]
sh scripts/release.sh >> "$RELEASE_TEST_DIR/output"
jq -e '.ref == "feature/release" and .inputs.tag == "v0.1.11" and .inputs.sha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$RELEASE_TEST_DIR/post" >/dev/null
rm "$RELEASE_TEST_DIR/post"

for scenario in dirty unpushed bad-remote http-error tag-error; do
  TEST_DIRTY= TEST_SHA= TEST_REMOTE= TEST_HTTP_ERROR=
  case "$scenario" in
    dirty) TEST_DIRTY=' M Cargo.toml' ;;
    unpushed) TEST_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
    bad-remote) TEST_REMOTE=https://user:test_token@example.com/owner/repo.git ;;
    http-error) TEST_HTTP_ERROR=yes ;;
    tag-error) TEST_HTTP_ERROR=tags ;;
  esac
  export TEST_DIRTY TEST_SHA TEST_REMOTE TEST_HTTP_ERROR
  if sh scripts/release.sh >> "$RELEASE_TEST_DIR/output" 2>&1; then
    printf 'Expected failure: %s\n' "$scenario" >&2
    exit 1
  fi
  [ ! -f "$RELEASE_TEST_DIR/post" ]
done
! grep -q test_token "$RELEASE_TEST_DIR/output"
printf 'Release checks passed\n'
