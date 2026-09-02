#!/usr/bin/env bash
# claude-quota driver.
#
#   ./ctl                  the verbs, with what each one does
#   ./ctl --list           the same, one `name<TAB>description` per line
#   ./ctl <verb> --list    what that verb takes
set -euo pipefail
cd "$(dirname "$0")"

VERBS="dev	Watch mode, or a run against mock input
build	Compile TypeScript
test	Run tests
check	Run the linter
deploy	Link it here, or cut a release"

qualifiers() {
  case "$1" in
    dev)    printf '%s\n' \
      "watch	tsc --watch (default)" \
      "stdin	Pipe mock stdin and print what comes out" ;;
    deploy) printf '%s\n' \
      "link	Build and link as the global 'claude-quota' binary (default)" \
      "release	Bump, build, test, commit, push, tag - [patch|minor|major]" ;;
    *)      return 1 ;;
  esac
}

list_for() {
  local verb="$1"
  if [[ -z "$verb" ]]; then printf '%s\n' "$VERBS"; return 0; fi
  qualifiers "$verb" || { echo "no qualifiers: $verb" >&2; exit 1; }
}

usage() {
  echo "Usage: ./ctl <verb> [qualifier]"
  echo ""
  printf '%s\n' "$VERBS" | while IFS="$(printf '\t')" read -r name why; do
    printf '  %-8s %s\n' "$name" "$why"
  done
  echo ""
  echo "  What a verb takes:  ./ctl <verb> --list"
}

deploy_link() {
  npm run build
  npm link
  echo "Installed. 'claude-quota' now points to $(pwd)/dist/index.js"
}

deploy_release() {
  local bump="${1:-patch}"

  if [[ "$bump" != patch && "$bump" != minor && "$bump" != major ]]; then
    echo "Usage: ./ctl deploy release [patch|minor|major]"
    exit 1
  fi

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: uncommitted changes — commit or stash first."
    exit 1
  fi

  # Bump version in package.json + package-lock.json (no git tag)
  npm version "$bump" --no-git-tag-version

  # Sync version to plugin.json
  VERSION=$(node -p "require('./package.json').version")
  node -e "
    const fs = require('fs');
    const path = '.claude-plugin/plugin.json';
    const obj = JSON.parse(fs.readFileSync(path, 'utf8'));
    obj.version = '$VERSION';
    fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  "

  # Verify
  npm run build
  npm test

  # Commit, push, tag, push tag
  git add package.json package-lock.json .claude-plugin/plugin.json
  git commit -m "$VERSION"
  git push
  git tag "v$VERSION"
  git push origin "v$VERSION"

  echo ""
  echo "Released v$VERSION — npm publish triggered by the v* tag."
}

cmd="${1:-}"; shift || true

case "$cmd" in
  ''|-h|--help) usage; exit 0 ;;
  --list)       list_for ""; exit 0 ;;
esac

for arg in "$@"; do
  [[ "$arg" == "--list" ]] || continue
  list_for "$cmd"
  exit 0
done

case "$cmd" in
  dev)
    case "${1:-watch}" in
      watch) npm run dev ;;
      stdin) npm run test:stdin ;;
      *)     echo "unknown: ./ctl dev $1  (./ctl dev --list)" >&2; exit 1 ;;
    esac
    ;;
  build)  npm run build ;;
  test)   npm test ;;
  check)  npm run lint ;;
  deploy)
    sub="${1:-link}"; shift 2>/dev/null || true
    case "$sub" in
      link)    deploy_link ;;
      release) deploy_release "$@" ;;
      *)       echo "unknown: ./ctl deploy $sub  (./ctl deploy --list)" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "unknown command: $cmd" >&2
    echo "" >&2
    usage >&2
    exit 1
    ;;
esac
