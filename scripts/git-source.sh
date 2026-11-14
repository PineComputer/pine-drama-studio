#!/usr/bin/env bash
# The source of the git a release ships, attached to the release: GPLv2 section 3(a) lets a binary go with its complete
# source. That is dugite-native at the tag dugite's install step downloads (its script/embedded-git.json), with its git
# submodule.
#
#   scripts/git-source.sh <dir>    writes <dir>/dugite-native-<tag>-source.tar.gz and prints its path
set -euo pipefail
out="$(cd "$1" && pwd)"
embedded="$(cd "$(dirname "$0")/.." && pwd)/extensions/pine-drama/node_modules/dugite/script/embedded-git.json"
# Each platform's entry names its release (.../releases/download/<tag>/<file>); one source covers them only if it is one.
tag="$(node -e '
	const tags = [...new Set(Object.values(require(process.argv[1])).map(e => e.url.split("/").at(-2)))];
	if (tags.length !== 1) throw new Error(`dugite downloads from more than one release: ${tags}`);
	console.log(tags[0]);
' "$embedded")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" --recurse-submodules --shallow-submodules https://github.com/desktop/dugite-native "$work/dugite-native-$tag"
# COPYFILE_DISABLE: macOS tar would add ._ files for extended attributes (tar(1), bsdtar).
COPYFILE_DISABLE=1 tar -C "$work" --exclude=.git -czf "$out/dugite-native-$tag-source.tar.gz" "dugite-native-$tag"
echo "$out/dugite-native-$tag-source.tar.gz"
