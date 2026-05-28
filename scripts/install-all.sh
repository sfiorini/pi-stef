#!/usr/bin/env bash
set -euo pipefail

REPO="git:github.com/<USER>/pi-stef"
PACKAGES=("superpowers-adapter")
SCOPE="global"

if [[ "${1:-}" == "--project" ]]; then
  SCOPE="project"
fi

# Check pi is available
if ! command -v pi &>/dev/null; then
  echo "Error: 'pi' not found in PATH. Install pi first: https://pi.dev"
  exit 1
fi

FLAG=""
if [[ "$SCOPE" == "project" ]]; then
  FLAG="-l"
fi

echo "Installing pi-stef packages (${SCOPE})..."
INSTALLED=()
FAILED=()

for pkg in "${PACKAGES[@]}"; do
  echo ""
  echo "Installing ${pkg}..."
  if pi install ${FLAG} "${REPO}#packages/${pkg}"; then
    INSTALLED+=("$pkg")
  else
    FAILED+=("$pkg")
    echo "Error: Failed to install ${pkg}"
  fi
done

echo ""
echo "=== Summary ==="
if [[ ${#INSTALLED[@]} -gt 0 ]]; then
  echo "Installed: ${INSTALLED[*]}"
fi
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed: ${FAILED[*]}"
  exit 1
fi
