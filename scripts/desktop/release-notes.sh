#!/usr/bin/env bash
# Generate detailed release notes from the commits between two tags.
#
# Usage:
#   scripts/desktop/release-notes.sh v1.0.12 [v1.0.11]
#
# The output is ready for `gh release create/edit --notes-file`. Commit bodies
# are kept under each entry because they often contain the user-facing details
# that a one-line commit title leaves out.

set -euo pipefail

usage() {
  printf 'Usage: %s TAG [PREVIOUS_TAG]\n' "$0" >&2
}

TAG="${1:-}"
PREVIOUS="${2:-}"

if [[ -z "${TAG}" || "${TAG}" == "--help" || "${TAG}" == "-h" ]]; then
  usage
  exit 2
fi

git rev-parse --verify "${TAG}^{commit}" >/dev/null || {
  printf 'Release tag not found: %s\n' "${TAG}" >&2
  exit 1
}

if [[ -z "${PREVIOUS}" ]]; then
  PREVIOUS="$(git tag --sort=-version:refname | grep -Fvx -- "${TAG}" | head -n 1 || true)"
fi

if [[ -z "${PREVIOUS}" ]]; then
  printf 'Previous release tag is required when Git cannot find one.\n' >&2
  exit 1
fi

git rev-parse --verify "${PREVIOUS}^{commit}" >/dev/null || {
  printf 'Previous release tag not found: %s\n' "${PREVIOUS}" >&2
  exit 1
}

RANGE="${PREVIOUS}..${TAG}"
COUNT="$(git rev-list --count --no-merges "${RANGE}")"

category_for() {
  case "$1" in
    fix:*|fix\(*|fix\ *|Fix:*|Fix\ *|bug:*|Bug:*|repair:*|Repair\ *)
      printf 'fixes'
      ;;
    feat:*|feat\(*|feat\ *|Add\ *|add\ *|Implement\ *|implement\ *)
      printf 'features'
      ;;
    perf:*|perf\(*|perf\ *|Improve\ *|improve\ *|Optimize\ *|optimize\ *)
      printf 'performance'
      ;;
    *)
      printf 'other'
      ;;
  esac
}

print_category() {
  local heading="$1"
  local category="$2"
  local found=0
  local commit subject body

  while IFS= read -r commit; do
    [[ -n "${commit}" ]] || continue
    subject="$(git show -s --format='%s' "${commit}")"
    [[ "$(category_for "${subject}")" == "${category}" ]] || continue

    if (( found == 0 )); then
      printf '### %s\n\n' "${heading}"
      found=1
    fi

    printf -- '- %s (`%s`)\n' "${subject}" "$(git show -s --format='%h' "${commit}")"
    body="$(git show -s --format='%b' "${commit}")"
    if [[ -n "${body}" ]]; then
      printf '%s\n' "${body}" | sed 's/^/  /'
      printf '\n'
    fi
  done < <(git log --no-merges --reverse --format='%H' "${RANGE}")

  if (( found == 1 )); then
    printf '\n'
  fi
}

printf '## OpenOpusClips %s\n\n' "${TAG#v}"
printf 'Changes since `%s` (%s non-merge commits).\n\n' "${PREVIOUS}" "${COUNT}"
printf '### What changed\n\n'
printf 'This release includes the user-facing fixes, features, reliability work, and maintenance listed below.\n\n'

print_category 'New features' features
print_category 'Bug fixes' fixes
print_category 'Performance and reliability' performance
print_category 'Other changes' other

printf '### Packaging and verification\n\n'
printf '%s\n' '- Add the installer platforms/architectures, signing or notarization result, updater files, and any known limitations before publishing.'
