#!/usr/bin/env bash
# Review-only diagnostic. Run once per fixed revision on disposable Linux.
set -euo pipefail
package=$(cd -- "$(dirname -- "$0")" && pwd)
source "$package/download-guard.sh"
repo=$(pwd)
revision=$(git rev-parse HEAD)
case "$revision" in
  86be22974dec93eb84654dcddcc3a395e8017598|b31558064093564fb937cf046596d1d497f5be27) ;;
  *) echo 'Refusing unreviewed source revision'; exit 2 ;;
esac
test -z "$(git status --porcelain --untracked-files=no)"
test "$(node --version)" = v24.21.0
test "$(pnpm --version)" = 9.15.4
test "$(git rev-parse HEAD:pnpm-lock.yaml)" = e98e7efd503926ab2381f6ebf5ae95e6995c294a
test "$(git rev-parse HEAD:packages/adapters/cursor-local/src/server/execute.test.ts)" = 866cdd952e09265466b2d1ed1cc111eca9bb6c5e
output=$(mktemp -d "${RUNNER_TEMP:?}/cursor-evidence-XXXXXXXX")
printf '%s\n' "evidence=$output" >> "${GITHUB_OUTPUT:?}"
git show -s --format='%H %T %P' > "$output/source.txt"
node --version >> "$output/source.txt"
pnpm --version >> "$output/source.txt"
uname -a >> "$output/source.txt"
cat /etc/os-release >> "$output/source.txt"
printf '%s\n' "${ImageOS:-unknown} ${ImageVersion:-unknown}" >> "$output/source.txt"
sha256sum pnpm-lock.yaml > "$output/lock.sha256"
pnpm install --frozen-lockfile > "$output/install.log" 2>&1
pnpm run preflight:workspace-links > "$output/preflight.log" 2>&1
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps > "$output/build-deps.log" 2>&1
# Each pass receives a fresh home/config/temp tree and no inherited credentials.
run_pass() {
  label=$1; shift
  fake=$(mktemp -d "${RUNNER_TEMP}/cursor-fixture-XXXXXXXX")
  mkdir -p "$fake/home" "$fake/paperclip" "$fake/tmp" "$fake/bin"
  # Check the actual patched runner closures, including calls with no input.env.
  # Keep expected check markers separate from forbidden test-pass markers.
  make_download_guard "$fake/check-bin" "$output/$label.guard-check.attempts"
  timeout --signal=TERM --kill-after=5s 30s env -i PATH="$PATH" \
    HOME="$fake/home" TMPDIR="$fake/tmp" CURSOR_DIAGNOSTIC_GUARD_DIR="$fake/check-bin" \
    node "$package/guard-check.cjs" \
    "$repo/packages/adapters/cursor-local/src/server/execute.test.ts" \
    "$output/$label.guard-check.attempts" "$fake" > "$output/$label.guard-check.log" 2>&1
  check_exit=0
  download_guard_status "$output/$label.guard-check.attempts" || check_exit=$?
  printf '%s\n' "$check_exit" > "$output/$label.guard-check.detector.exit"
  test "$check_exit" = 97
  make_download_guard "$fake/bin" "$output/$label.forbidden-attempts"
  set +e
  timeout --signal=TERM --kill-after=10s 90s env -i \
    PATH="$fake/bin:$PATH" HOME="$fake/home" TMPDIR="$fake/tmp" \
    CURSOR_DIAGNOSTIC_GUARD_DIR="$fake/bin" \
    PAPERCLIP_HOME="$fake/paperclip" PAPERCLIP_CONFIG="$fake/paperclip/config.json" \
    PAPERCLIP_TEST_HOST_HOME="$fake/paperclip" PAPERCLIP_INSTANCE_ID=cursor-fixture \
    NODE_ENV=test CI=true NO_COLOR=1 \
    node "$repo/node_modules/vitest/vitest.mjs" run --exclude '**/dist/**' \
    --project @paperclipai/adapter-cursor-local "$@" > "$output/$label.log" 2>&1
  pass_exit=$?
  set -e
  printf '%s\n' "$pass_exit" > "$output/$label.exit"
  guard_exit=0
  download_guard_status "$output/$label.forbidden-attempts" || guard_exit=$?
  printf '%s\n' "$guard_exit" > "$output/$label.guard.exit"
  cat "$output/$label.log"
  # Preserve the test exit above; a hidden/pipeline-masked attempt still fails.
  test "$guard_exit" = 0 || exit "$guard_exit"
}
git apply --check "$package/negative-control.patch"
git apply "$package/negative-control.patch"
git apply --check "$package/diagnostic-guard.patch"
git apply "$package/diagnostic-guard.patch"
git diff > "$output/negative-with-guard.diff"
run_pass negative packages/adapters/cursor-local/src/server/execute.test.ts \
  -t 'reruns sandbox command resolution after managed runtime setup and keeps the original sandbox home'
git apply -R "$package/diagnostic-guard.patch"
git apply -R "$package/negative-control.patch"
# The negative control must fail specifically at the intercepted installer.
test "$(cat "$output/negative.exit")" = 1
grep -q FIXTURE_EXTERNAL_INSTALL_REACHED "$output/negative.log"
git apply --check "$package/candidate.patch"
git apply "$package/candidate.patch"
git diff --check
git diff > "$output/candidate.diff"
git apply --check "$package/diagnostic-guard.patch"
git apply "$package/diagnostic-guard.patch"
git diff --check
git diff > "$output/candidate-with-guard.diff"
run_pass candidate
git status --short > "$output/final-status.txt"
# Do not conceal the actual candidate test exit behind a successful upload.
exit "$(cat "$output/candidate.exit")"
