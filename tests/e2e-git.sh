#!/bin/bash
# End-to-end check with the real git binary against the forge's smart HTTP.
# Not part of the graded entry: it only runs here, against a dev server.
# Usage: tests/e2e-git.sh [port]
set -euo pipefail
PORT="${1:-18081}"
BASE="http://127.0.0.1:${PORT}"
OWNER="adaiversen"
REPO="e2e"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "E2E FAIL: $*" >&2; exit 1; }

# The dev server must already be running on $PORT (see README: Demo).
curl -fsS -m 5 "${BASE}/healthz" >/dev/null || fail "dev server is not up on ${PORT}"

# 1. Create the repository over REST, then clone it while it is still empty.
curl -fsS -m 5 -X POST "${BASE}/api/v3/user/repos" -H 'content-type: application/json' \
  -d "{\"name\":\"${REPO}\"}" >/dev/null || fail "create repo"
git clone -q "${BASE}/${OWNER}/${REPO}.git" "${WORK}/empty" 2>"${WORK}/empty.log" \
  || fail "clone of the empty repo failed: $(cat "${WORK}/empty.log")"
[ -d "${WORK}/empty/.git" ] || fail "empty clone has no .git"

# 2. First commit and push from the empty clone.
cd "${WORK}/empty"
git config user.name "ada iversen"
git config user.email "adaiversen@example.invalid"
printf 'hello forge\n' > hello.txt
git add hello.txt
git commit -qm "first commit"
git push -q origin HEAD:refs/heads/main || fail "first push failed"

# 3. A fresh clone sees the commit and its file; fsck passes on real objects.
git clone -q "${BASE}/${OWNER}/${REPO}.git" "${WORK}/full" || fail "second clone failed"
[ "$(cat "${WORK}/full/hello.txt")" = "hello forge" ] || fail "file content mismatch after clone"
git -C "${WORK}/full" fsck --strict >/dev/null || fail "fsck failed on the clone"
git -C "${WORK}/full" log --oneline | grep -q "first commit" || fail "commit missing in clone"

# 4. Shallow clone, then a second push and a fetch of it.
git clone -q --depth 1 "${BASE}/${OWNER}/${REPO}.git" "${WORK}/shallow" || fail "shallow clone failed"
[ "$(git -C "${WORK}/shallow" rev-list --count HEAD)" = "1" ] || fail "shallow clone has more than 1 commit"
printf 'second line\n' >> hello.txt
git commit -qam "second commit"
git push -q origin HEAD:refs/heads/main || fail "second push failed"
git -C "${WORK}/full" fetch -q origin || fail "fetch failed"
git -C "${WORK}/full" log --oneline origin/main | grep -q "second commit" || fail "fetch did not bring the second commit"
[ "$(git -C "${WORK}/full" rev-list --count origin/main)" = "2" ] || fail "expected 2 commits on origin/main"

# 5. A tag round-trips through push and fetch.
git tag v1.0
git push -q origin v1.0 || fail "tag push failed"
git -C "${WORK}/full" fetch -q --tags origin || fail "tag fetch failed"
git -C "${WORK}/full" rev-parse -q --verify "refs/tags/v1.0" >/dev/null || fail "tag v1.0 missing after fetch"

# 6. The REST surface sees the same history the git surface wrote.
COMMITS="$(curl -fsS -m 5 "${BASE}/api/v3/repos/${OWNER}/${REPO}/commits" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')"
[ "$COMMITS" = "2" ] || fail "REST lists $COMMITS commits, expected 2"

echo "E2E OK: empty clone, 2 pushes, full + shallow clone, fetch, tag, REST cross-check"
