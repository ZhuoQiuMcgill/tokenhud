#!/bin/sh
# Installs tokenhud on Linux or macOS: downloads the release binary for this machine from
# GitHub Releases, checks its SHA-256 against the release's SHA256SUMS, and puts it in
# ~/.local/bin. No sudo. Safe to run again: it reinstalls, or updates to the newest release.
#
#   curl -fsSL https://raw.githubusercontent.com/ZhuoQiuMcgill/tokenhud/main/install.sh | sh
#
# Environment:
#   TOKENHUD_VERSION        a release to install, e.g. 0.1.0 or v0.1.0-rc.1 (default: the
#                           latest stable release)
#   TOKENHUD_INSTALL        the directory to install into (default: ~/.local/bin)
#   TOKENHUD_DOWNLOAD_BASE  where releases are downloaded from (default: the repository's
#                           GitHub Releases); for testing against a local copy

set -eu

repo="ZhuoQiuMcgill/tokenhud"
base="${TOKENHUD_DOWNLOAD_BASE:-https://github.com/$repo/releases}"
base="${base%/}"
dir="${TOKENHUD_INSTALL:-$HOME/.local/bin}"
version="${TOKENHUD_VERSION:-}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'tokenhud install: %s\n' "$*" >&2
  exit 1
}

# ── this machine ─────────────────────────────────────────────────────────────────────

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "on Windows, use install.ps1: irm https://raw.githubusercontent.com/$repo/main/install.ps1 | iex"
    ;;
  *) fail "no tokenhud binary for $(uname -s); see https://github.com/$repo" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no tokenhud binary for the $(uname -m) architecture" ;;
esac

# A shell under Rosetta reports x86_64 on Apple silicon; the native binary is the better one.
if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

libc=""
if [ "$os" = linux ]; then
  for loader in /lib/ld-musl-*.so.1; do
    [ -e "$loader" ] && libc="-musl"
  done
  if [ -z "$libc" ] && ldd --version 2>&1 | grep -qi musl; then libc="-musl"; fi
fi

asset="tokenhud-$os-$arch$libc"

# ── where from ───────────────────────────────────────────────────────────────────────

if [ -n "$version" ]; then
  tag="v${version#v}"
  url="$base/download/$tag"
else
  tag="the latest release"
  url="$base/latest/download"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "needs curl or wget to download"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
elif command -v openssl >/dev/null 2>&1; then
  sha256() { openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1; }
else
  fail "needs sha256sum, shasum or openssl to check the download"
fi

# ── download and check ───────────────────────────────────────────────────────────────

mkdir -p "$dir" || fail "can't create $dir"
# Staged beside the target, so the final move is a rename on the same file system.
tmp="$dir/.tokenhud-install.$$"
sums="$dir/.tokenhud-sums.$$"
trap 'rm -f "$tmp" "$sums"' EXIT
trap 'exit 1' HUP INT TERM

say "Downloading $asset ($tag)"
if ! fetch "$url/SHA256SUMS" "$sums"; then
  if [ -z "$version" ]; then
    fail "no stable release found at $base; pick one with TOKENHUD_VERSION (see $base)"
  fi
  fail "release $tag not found at $base"
fi
expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$sums")
[ -n "$expected" ] || fail "release $tag has no $asset"
fetch "$url/$asset" "$tmp" || fail "download of $asset failed"
actual=$(sha256 "$tmp" | tr 'A-F' 'a-f')
if [ "$actual" != "$expected" ]; then
  fail "$asset failed its checksum (expected $expected, got $actual); nothing was installed"
fi
say "Checksum ok"

chmod 755 "$tmp"
mv -f "$tmp" "$dir/tokenhud"

# ── report ───────────────────────────────────────────────────────────────────────────

if ! installed=$("$dir/tokenhud" --version 2>&1); then
  say "Installed $dir/tokenhud, but it doesn't start:"
  say "$installed" | head -n 3
  if [ -n "$libc" ]; then
    say "On Alpine and other musl systems it needs the C++ runtime: apk add libstdc++ libgcc"
  fi
  exit 1
fi
say "Installed $installed to $dir/tokenhud"

case ":${PATH:-}:" in
  *":$dir:"*) ;;
  *)
    say ""
    say "$dir is not on your PATH. Add it, e.g. in ~/.profile, ~/.bashrc or ~/.zshrc:"
    say "  export PATH=\"$dir:\$PATH\""
    say "or for fish: fish_add_path $dir"
    ;;
esac
say ""
say "Run tokenhud to start. Update later with: tokenhud update"
