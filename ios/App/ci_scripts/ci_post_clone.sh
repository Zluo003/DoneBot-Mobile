#!/bin/sh
set -eu

cd "${CI_PRIMARY_REPOSITORY_PATH:-$(dirname "$0")/../../..}"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 24 ? 1 : 0)'; then
  brew install node@24
  node_prefix=$(brew --prefix node@24)
  export PATH="$node_prefix/bin:$PATH"
fi

# Use the pnpm version declared in package.json, including on fresh cloud machines.
package_manager=$(node -p 'require("./package.json").packageManager')
npm exec --yes --package="$package_manager" -- pnpm install --frozen-lockfile

# Generate the web bundle and the local Swift package paths before Xcode resolves them.
npm exec --yes --package="$package_manager" -- pnpm ios:sync
