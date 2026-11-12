#!/bin/bash
# Builds the module package (castika-audiostatus-<ver>.tgz): yarn install + yarn package.
#
# Builds never run inside the source folder. It is copied to
# $AUDIOSTATUS_BUILD_DIR (default ~/audiostatus-build), yarn runs there, and only
# the finished .tgz and the yarn.lock come back.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd -P)"
BUILD="${AUDIOSTATUS_BUILD_DIR:-$HOME/audiostatus-build}"
YARN="npx --yes @yarnpkg/cli-dist@4.17.0"  # yarn 4 without needing corepack here

mkdir -p "$BUILD"
rsync -a --delete --exclude node_modules --exclude pkg --exclude '*.tgz' --exclude .yarn --exclude .git "$SRC/" "$BUILD/"
cd "$BUILD"
$YARN install
rm -f ./*.tgz
$YARN package
VER=$(node -p "require('./package.json').version")
rm -f "$SRC/castika-audiostatus-"*.tgz
cp "castika-audiostatus-$VER.tgz" "$SRC/"
cp yarn.lock "$SRC/yarn.lock"
echo "built in $BUILD"
ls -l "$SRC/castika-audiostatus-$VER.tgz"
