#!/usr/bin/env bash
# Package Pine Drama Studio as a macOS .app.
#
#   scripts/package-macos.sh                   full build: Code-OSS at the pin + our patch series, the product overlay,
#                                              upstream's packaging target, our built-in extension; then a zip
#   scripts/package-macos.sh --min             the same with upstream's minified target (slower; for a public release)
#   scripts/package-macos.sh --allow-dirty     build from uncommitted files too (a local try; refused otherwise)
#   scripts/package-macos.sh --extension-only  replace only the built-in extension and the icon in the last full build,
#                                              and zip again (no gulp run)
#   scripts/package-macos.sh --arch=x64        for Intel Macs (default: arm64, Apple silicon); combines with the above
#
# The build runs in its own git worktree of the Code-OSS checkout (PKG_DIR, default <VSCODE_DIR>-pkg-<arch>), never in
# VSCODE_DIR itself, which a running dev Studio uses. Each build gets a folder of its own, dist/darwin-<arch>/<version>-b<N>/,
# holding the app, its disk image (.dmg), its zip and its build-info.json, so a build never writes over an app that may be
# open; dist/darwin-<arch>/latest names the newest. Before zipping, the integrity checksums in the app's product.json are
# recomputed and compared, offline. Unsigned (macOS asks before the first open); scripts/release-macos.mjs signs it.
set -euo pipefail
STUDIO="$(cd "$(dirname "$0")/.." && pwd)"
VSCODE_DIR="$(cd "${VSCODE_DIR:-$STUDIO/../vscode}" && pwd)"
EXT="$STUDIO/extensions/pine-drama"
APP_NAME="Pine Drama Studio"
lock() { grep -E "^$1=" "$STUDIO/upstream/vscode.lock" | cut -d= -f2-; }
BASE="$(lock base)"

MODE=full MIN= DIRTY=refuse ARCH=arm64
for arg in "$@"; do
	case "$arg" in
		--min) MIN=-min ;;
		--extension-only) MODE=extension ;;
		--allow-dirty) DIRTY=allow ;;
		--arch=arm64 | --arch=x64) ARCH="${arg#--arch=}" ;;
		*) echo "unknown option $arg" >&2; exit 2 ;;
	esac
done
# Upstream's packaging targets for macOS (build/gulpfile.vscode.ts, BUILD_TARGETS): vscode-darwin-<arch>[-min].
TARGET="vscode-darwin-$ARCH$MIN"
# One packaging worktree and one dist/ folder per architecture: their node_modules hold different native binaries.
PKG_DIR="${PKG_DIR:-$VSCODE_DIR-pkg-$ARCH}"
DIST="$STUDIO/dist/darwin-$ARCH"

# What a build is made of, as hashes: the pin and patch series, and the product overlay (product fields and the built-in
# extensions kept). --extension-only refuses a shell built from anything else, so a stale shell is never shipped. The icon
# is not part of the shell: it is one file in the bundle, put in by both paths (place_icon).
sha() { shasum -a 256 | cut -d' ' -f1; }
series_sha() { { echo "$BASE"; cat "$STUDIO"/upstream/patches/*.patch; } | sha; }
overlay_sha() { cat "$STUDIO/upstream/product.package.json" "$STUDIO/upstream/builtin-extensions.allow" | sha; }
LATEST="$DIST/latest"
info() { node -e 'const i=require(process.argv[1]); console.log(i[process.argv[2]] ?? "")' "$LATEST/build-info.json" "$1"; }
next_build() { local n=0 d; for d in "$DIST"/*-b*/; do [ -d "$d" ] || continue; d="${d%/}"; n=$(( ${d##*-b} > n ? ${d##*-b} : n )); done; echo $(( n + 1 )); }
version() { node -p "require('$EXT/package.json').version"; }
# A release build: the minified target, for people. It ships no source maps and no readable extension source.
release() { local t="$TARGET"; [ "$MODE" = extension ] && t="$(info target)"; [ "$t" = "vscode-darwin-$ARCH-min" ] && echo yes || echo no; }

# The built-in extension: compiled here, copied with its production dependencies only. An extension in the app's
# extensions/ folder is built-in: it cannot be uninstalled, and it may use the proposed APIs its package.json enables
# (Code-OSS extensionsProposedApi.ts: only non-built-in extensions are refused them).
stage_extension() {
	local app="$1" stage
	(cd "$EXT" && npm run --silent compile)
	stage="$(mktemp -d)/pine-drama"
	mkdir -p "$stage"
	cp -R "$EXT/package.json" "$EXT/package-lock.json" "$EXT/out" "$EXT/media" "$EXT/syntaxes" "$EXT/protocol" "$stage/"
	rm -rf "$stage/out/test"
	if [ "$(release)" = yes ]; then
		# A release ships the extension as one minified bundle, without comments or source maps: tsc's output is the
		# source itself, comments included, and a map gives it back whole. Its dependencies stay in node_modules.
		rm -rf "$stage/out"
		(cd "$EXT" && npx --no-install esbuild src/extension.ts --bundle --platform=node --format=cjs --target=node20 \
			--packages=external --external:vscode --minify --legal-comments=none --log-level=warning --outfile="$stage/out/extension.js")
	fi
	# Its production dependencies, installed from the lockfile for the app's architecture: an optional native package
	# such as @napi-rs/canvas-darwin-<arch> is chosen by npm's --cpu and --os (npm install, "cpu" and "os").
	(cd "$stage" && npm ci --omit=dev --cpu="$ARCH" --os=darwin --no-audit --no-fund >/dev/null)
	rm -f "$stage/package-lock.json"
	rm -rf "$app/Contents/Resources/app/extensions/pine-drama"
	mv "$stage" "$app/Contents/Resources/app/extensions/pine-drama"
}

# The app icon: upstream/icons/pine-drama-studio.icns as the file Info.plist names (CFBundleIconFile). Packaging copies
# resources/darwin/code.icns there; replacing it after packaging is the same file, so a new icon needs no rebuild.
place_icon() {
	local app="$1"
	cp "$STUDIO/upstream/icons/pine-drama-studio.icns" "$app/Contents/Resources/$(plutil -extract CFBundleIconFile raw "$app/Contents/Info.plist")"
	touch "$app"
}

# Code-OSS refuses a changed install ("appears to be corrupt") when a file product.json lists under `checksums` no longer
# hashes as recorded (integrityService.ts; checksumService.ts: sha256, base64 without padding). Packaging writes them;
# nothing after it may change those files, and this proves it before a build is zipped.
verify_checksums() {
	node -e '
		const fs = require("fs"), path = require("path"), crypto = require("crypto");
		const root = path.join(process.argv[1], "Contents/Resources/app");
		const sums = JSON.parse(fs.readFileSync(path.join(root, "product.json"), "utf8")).checksums || {};
		const bad = Object.entries(sums).filter(([rel, want]) =>
			crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "out", rel))).digest("base64").replace(/=+$/, "") !== want);
		if (!Object.keys(sums).length) { console.error("product.json has no checksums"); process.exit(1); }
		if (bad.length) { console.error("checksum mismatch: " + bad.map(([rel]) => rel).join(", ")); process.exit(1); }
		console.log(`checksums: ${Object.keys(sums).length} file(s) match`);
	' "$1"
}

# The disk image people install from: the app and an Applications link, so the window shows drag-to-install; UDZO
# compressed, made with macOS's own hdiutil (hdiutil(1)). It is checked before it is kept: hdiutil verify, then mounted
# read-only and hidden from Finder (-nobrowse, -noautoopen), the app's Info.plist and checksums read inside, detached.
make_dmg() {
	local dir="$1" stage dmg mnt
	dmg="$dir/Pine-Drama-Studio-$(version)-darwin-$ARCH.dmg"
	stage="$(mktemp -d)"
	cp -cR "$dir/$APP_NAME.app" "$stage/$APP_NAME.app"
	ln -s /Applications "$stage/Applications"
	hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$stage" -format UDZO -ov "$dmg"
	rm -rf "$stage"
	hdiutil verify -quiet "$dmg"
	mnt="$(mktemp -d)"
	hdiutil attach -quiet -readonly -nobrowse -noautoopen -mountpoint "$mnt" "$dmg"
	local ok=yes
	[ "$(plutil -extract CFBundleIdentifier raw "$mnt/$APP_NAME.app/Contents/Info.plist")" = "$(node -p "require('$STUDIO/upstream/product.package.json').darwinBundleIdentifier")" ] || ok=no
	[ -L "$mnt/Applications" ] || ok=no
	verify_checksums "$mnt/$APP_NAME.app" >/dev/null || ok=no
	hdiutil detach -quiet "$mnt"; rmdir "$mnt"
	[ "$ok" = yes ] || { echo "the disk image does not hold the app as built: $dmg" >&2; exit 1; }
	# Production connects through native Accounts; do not distribute the private-development tunnel helper.
	echo "$dmg"
}

zip_app() {
	local dir="$1" build="$2" zip
	zip="$dir/Pine-Drama-Studio-$(version)-b$build-darwin-$ARCH.zip"
	# ditto keeps the bundle's symlinks and attributes, as Finder's Compress does (ditto(1)).
	(cd "$dir" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME.app" "$zip")
	echo "$zip"
}

write_info() {
	node -e '
		const [file, ...kv] = process.argv.slice(1);
		const info = {};
		for (let i = 0; i < kv.length; i += 2) info[kv[i]] = kv[i + 1];
		require("fs").writeFileSync(file, JSON.stringify(info, null, "\t") + "\n");
	' "$OUT_DIR/build-info.json" "$@"
	ln -sfn "$(basename "$OUT_DIR")" "$LATEST"
}

# A build people get is made from committed files only, so build-info.json names what it holds. --allow-dirty is for a
# local try; its build-info says "+changes".
changed="$(git -C "$STUDIO" status --porcelain -- extensions/pine-drama upstream scripts/package-macos.sh)"
if [ -n "$changed" ] && [ "$DIRTY" = refuse ]; then
	echo "refused: uncommitted changes in what the app is built from:" >&2; echo "$changed" >&2
	echo "commit them, or pass --allow-dirty for a local try" >&2; exit 1
fi
from() { git -C "$STUDIO" rev-parse --short HEAD; [ -z "$changed" ] || printf '+changes'; }

started=$(date +%s)
mkdir -p "$DIST"

if [ "$MODE" = extension ]; then
	[ -f "$LATEST/build-info.json" ] && [ -d "$LATEST/$APP_NAME.app" ] || { echo "no full build in dist/; run scripts/package-macos.sh first" >&2; exit 1; }
	if [ "$(info series)" != "$(series_sha)" ]; then
		echo "refused: the Code-OSS pin or patch series changed since $(readlink "$LATEST") was built ($(info builtFrom)); run a full build" >&2; exit 1
	fi
	if [ "$(info overlay)" != "$(overlay_sha)" ]; then
		echo "refused: the product overlay (upstream/product.package.json or the extension allowlist) changed since the last full build; run a full build" >&2; exit 1
	fi
	build=$(next_build)
	OUT_DIR="$DIST/$(version)-b$build"
	mkdir -p "$OUT_DIR"
	# A copy of the last build, so the app it came from stays as it was.
	cp -cR "$LATEST/$APP_NAME.app" "$OUT_DIR/$APP_NAME.app"
	stage_extension "$OUT_DIR/$APP_NAME.app"
	place_icon "$OUT_DIR/$APP_NAME.app"
	verify_checksums "$OUT_DIR/$APP_NAME.app"
	zip=$(zip_app "$OUT_DIR" "$build")
	dmg=$(make_dmg "$OUT_DIR")
	write_info series "$(series_sha)" overlay "$(overlay_sha)" build "$build" target "$(info target)" builtFrom "$(info builtFrom)" \
		extensionFrom "$(from)" \
		version "$(version)" at "$(date -u +%FT%TZ)"
	echo "extension and icon replaced in $(( $(date +%s) - started )) s: $dmg ($(du -h "$dmg" | cut -f1)), $zip"
	exit 0
fi

# ---- full build ----

# 1. Code-OSS at the pin with our patch series, in the packaging worktree; the series is the source of truth.
if [ ! -d "$PKG_DIR" ]; then
	git -C "$VSCODE_DIR" worktree add --detach "$PKG_DIR" "$BASE"
fi
git -C "$PKG_DIR" checkout -q --detach "$BASE"
git -C "$PKG_DIR" reset -q --hard "$BASE"
# Keep the dependencies and caches between builds; everything else returns to the pin.
git -C "$PKG_DIR" clean -q -fdx -e node_modules -e .build/builtInExtensions
git -C "$PKG_DIR" -c user.name=pine-package -c user.email=pine-package@localhost am -q --3way "$STUDIO"/upstream/patches/*.patch
# Dependencies. For this Mac's own architecture: APFS clones of the dev checkout's (same base, same lockfiles), so no
# download and almost no disk; each node_modules folder the worktree lacks is cloned, so a folder lost since the last
# build is restored. For the other architecture: installed once in the worktree for that architecture, as upstream's
# macOS build installs each architecture's (build/azure-pipelines/darwin/product-build-darwin-node-modules.yml:
# npm ci with npm_config_arch, no Electron or Playwright download, GYP_DEFINES kerberos_use_rtld=false).
if [ "$ARCH" = "$(node -p process.arch)" ]; then
	(cd "$VSCODE_DIR" && find . -name node_modules -type d -prune -not -path './.build/*') | while read -r d; do
		[ -d "$PKG_DIR/$d" ] || { mkdir -p "$PKG_DIR/$(dirname "$d")"; cp -cR "$VSCODE_DIR/$d" "$PKG_DIR/$d"; }
	done
elif [ ! -d "$PKG_DIR/node_modules" ]; then
	(cd "$PKG_DIR" && npm_config_arch="$ARCH" ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
		GYP_DEFINES=kerberos_use_rtld=false npm ci)
fi
if [ -d "$VSCODE_DIR/.build/builtInExtensions" ] && [ ! -d "$PKG_DIR/.build/builtInExtensions" ]; then
	mkdir -p "$PKG_DIR/.build" && cp -cR "$VSCODE_DIR/.build/builtInExtensions" "$PKG_DIR/.build/"
fi

# 2. The product overlay: Pine's product fields and only the built-in extensions on the allowlist (the icon is placed
# after packaging, place_icon).
node -e '
	const fs = require("fs");
	const [product, overlay, allowFile] = process.argv.slice(1);
	const allow = new Set(fs.readFileSync(allowFile, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")));
	const p = { ...JSON.parse(fs.readFileSync(product, "utf8")), ...JSON.parse(fs.readFileSync(overlay, "utf8")) };
	p.builtInExtensions = (p.builtInExtensions || []).filter(e => allow.has(e.name));
	fs.writeFileSync(product, JSON.stringify(p, null, "\t") + "\n");
' "$PKG_DIR/product.json" "$STUDIO/upstream/product.package.json" "$STUDIO/upstream/builtin-extensions.allow"
# Extensions off the allowlist are still compiled: build/gulpfile.extensions.ts names its compilations in a fixed list,
# so removing their sources breaks the build. They are removed from the packaged app below instead. GitHub Copilot is
# the exception: it is packaged by a task of its own, which skips a missing extensions/copilot, and patch 0003 lets the
# packaging step after it do the same.
rm -rf "$PKG_DIR/extensions/copilot"

# 3. Upstream's packaging target (build/gulpfile.vscode.ts, BUILD_TARGETS): writes <PKG_DIR>/../VSCode-darwin-<arch>.
# The build's commit, for product.json: getVersion (build/lib/getVersion.ts) cannot read it in a worktree, whose .git is
# a file, and without it Code-OSS looks for its unpacked node modules in the wrong place (appNodeModules.ts).
(cd "$PKG_DIR" && BUILD_SOURCEVERSION="$(git rev-parse HEAD)" npm run gulp -- "$TARGET")
OUT="$(dirname "$PKG_DIR")/VSCode-darwin-$ARCH/$APP_NAME.app"
[ -d "$OUT" ] || { echo "packaging wrote no $OUT" >&2; exit 1; }
build=$(next_build)
OUT_DIR="$DIST/$(version)-b$build"
mkdir -p "$OUT_DIR"
cp -cR "$OUT" "$OUT_DIR/$APP_NAME.app"

# 4. Leave out what the allowlist does not keep (Copilot included), then add our built-in extension.
for manifest in "$OUT_DIR/$APP_NAME.app"/Contents/Resources/app/extensions/*/package.json; do
	dir="$(dirname "$manifest")"
	id="$(node -p "const p=require('$manifest'); p.publisher + '.' + p.name")"
	grep -qxF "$id" "$STUDIO/upstream/builtin-extensions.allow" || rm -rf "$dir"
done
stage_extension "$OUT_DIR/$APP_NAME.app"
# Upstream writes Microsoft's copyright into Info.plist (build/lib/electron.ts, `copyright`), which Finder's Get Info shows.
# The bundle is unsigned, so it is rewritten here rather than by a patch. CFBundleShortVersionString stays Code-OSS's:
# extensions check their `engines.vscode` against it.
place_icon "$OUT_DIR/$APP_NAME.app"
# A release build ships no source maps (about 270 MB): upstream's own builds publish theirs to a CDN instead
# (build/gulpfile.vscode.ts, useCdnSourceMapsForPackagingTasks). No file product.json checksums is a map.
[ "$(release)" = yes ] && find "$OUT_DIR/$APP_NAME.app/Contents/Resources/app/out" -name '*.map' -delete
plutil -replace NSHumanReadableCopyright -string "Copyright (C) 2026 19Pine. All rights reserved." "$OUT_DIR/$APP_NAME.app/Contents/Info.plist"
verify_checksums "$OUT_DIR/$APP_NAME.app"
node -e 'process.exit(require(process.argv[1]).commit ? 0 : 1)' "$OUT_DIR/$APP_NAME.app/Contents/Resources/app/product.json" || { echo "product.json has no commit" >&2; exit 1; }

# 5. Zip, and record what this shell was built from.
zip=$(zip_app "$OUT_DIR" "$build")
dmg=$(make_dmg "$OUT_DIR")
write_info series "$(series_sha)" overlay "$(overlay_sha)" build "$build" target "$TARGET" \
	builtFrom "studio $(from), Code-OSS ${BASE:0:11} + $(ls "$STUDIO"/upstream/patches/*.patch | wc -l | tr -d ' ') patch(es)" \
	extensionFrom "$(from)" version "$(version)" at "$(date -u +%FT%TZ)"
echo "built in $(( $(date +%s) - started )) s: $dmg ($(du -sh "$OUT_DIR/$APP_NAME.app" | cut -f1) app, $(du -h "$dmg" | cut -f1) dmg, $(du -h "$zip" | cut -f1) zip)"
