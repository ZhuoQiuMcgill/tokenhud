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
#   TOKENHUD_DOWNLOAD_BASE  for tests: where releases are downloaded from instead of the
#                           repository's GitHub Releases. Must be https:// unless
#                           TOKENHUD_INSECURE_TEST=1 (which allows http:// and file://).
#
# Everything is in main(), called on the last line, so a download cut short runs nothing.

set -eu

repo="ZhuoQiuMcgill/tokenhud"
github="https://github.com/$repo/releases"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
fail() {
  warn "tokenhud install: $*"
  exit 1
}

# The C library this Linux runs on, as the system answers it: glibc knows its own version
# (getconf), and ldd names its libc. A musl loader on disk proves nothing by itself: glibc
# systems can have one for building musl programs. It decides only when neither answers.
host_libc() {
  if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    echo glibc
    return
  fi
  case "$(ldd --version 2>&1 || true)" in
    *musl*)
      echo musl
      return
      ;;
    *GLIBC* | *glibc* | *"GNU C Library"* | *"GNU libc"*)
      echo glibc
      return
      ;;
  esac
  for loader in /lib/ld-musl-*.so.1; do
    if [ -e "$loader" ]; then
      echo musl
      return
    fi
  done
  echo glibc
}

# fetch URL FILE: 0 when downloaded, 1 when the server has no such file (HTTP 404), 2 when
# the download failed otherwise, with the reason in $why. Over https only, redirects
# included, unless TOKENHUD_INSECURE_TEST=1.
fetch() {
  if [ "$downloader" = curl ]; then
    if [ "$insecure" = 1 ]; then
      code=$(curl -sSL --retry 3 -o "$2" -w '%{http_code}' "$1" 2>"$errlog") || code=fail
    else
      code=$(curl -sSL --proto =https --proto-redir =https --retry 3 -o "$2" \
        -w '%{http_code}' "$1" 2>"$errlog") || code=fail
    fi
    case "$code" in
      2?? | 000) return 0 ;; # 000: a file:// URL, which has no status (tests)
      404) return 1 ;;
      fail)
        why=$(tail -n 1 "$errlog")
        return 2
        ;;
      *)
        why="HTTP $code"
        return 2
        ;;
    esac
  fi
  if [ "$insecure" != 1 ] && wget --help 2>&1 | grep -q -- --https-only; then
    wget -S -q --https-only -O "$2" "$1" 2>"$errlog" && return 0
  else
    wget -S -q -O "$2" "$1" 2>"$errlog" && return 0
  fi
  if grep -q ' 404' "$errlog"; then return 1; fi
  why=$(grep -v '^ ' "$errlog" | tail -n 1)
  [ -n "$why" ] || why="wget failed"
  return 2
}

main() {
  base="${TOKENHUD_DOWNLOAD_BASE:-$github}"
  base="${base%/}"
  dir="${TOKENHUD_INSTALL:-$HOME/.local/bin}"
  version="${TOKENHUD_VERSION:-}"
  insecure="${TOKENHUD_INSECURE_TEST:-}"

  # ── where from ─────────────────────────────────────────────────────────────────────

  if [ "$base" != "$github" ]; then
    warn ""
    warn "WARNING: downloading from $base (TOKENHUD_DOWNLOAD_BASE), not from GitHub."
    warn "WARNING: its SHA256SUMS comes from the same place, so use only a source you trust."
    warn ""
  fi
  case "$base" in
    https://*) ;;
    http://* | file://*)
      [ "$insecure" = 1 ] ||
        fail "TOKENHUD_DOWNLOAD_BASE must be an https:// URL, not $base (TOKENHUD_INSECURE_TEST=1 allows it for tests)"
      ;;
    *) fail "TOKENHUD_DOWNLOAD_BASE must be an https:// URL, not $base" ;;
  esac

  # ── this machine ───────────────────────────────────────────────────────────────────

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
  if [ "$os" = linux ] && [ "$(host_libc)" = musl ]; then libc="-musl"; fi
  asset="tokenhud-$os-$arch$libc"

  if [ -n "$version" ]; then
    tag="v${version#v}"
    url="$base/download/$tag"
  else
    tag="the latest release"
    url="$base/latest/download"
  fi

  if command -v curl >/dev/null 2>&1; then
    downloader=curl
  elif command -v wget >/dev/null 2>&1; then
    downloader=wget
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

  # ── download and check ─────────────────────────────────────────────────────────────

  # Staged beside the target, so the final move is a rename on the same file system.
  tmp="$dir/.tokenhud-install.$$"
  sums="$dir/.tokenhud-sums.$$"
  errlog="$dir/.tokenhud-errors.$$"
  if ! mkdir -p "$dir" 2>/dev/null || ! touch "$tmp" 2>/dev/null; then
    fail "can't write to $dir; choose a directory you own with TOKENHUD_INSTALL"
  fi
  trap 'rm -f "$tmp" "$sums" "$errlog"' EXIT
  trap 'exit 1' HUP INT TERM

  say "Downloading $asset ($tag)"
  why=""
  status=0
  fetch "$url/SHA256SUMS" "$sums" || status=$?
  if [ "$status" -eq 1 ] && [ -z "$version" ]; then
    fail "no stable release found at $base; pick a release with TOKENHUD_VERSION (see $base)"
  elif [ "$status" -eq 1 ]; then
    fail "release $tag not found at $base: is TOKENHUD_VERSION right?"
  elif [ "$status" -ne 0 ]; then
    fail "couldn't download from $base: $why"
  fi
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$sums")
  [ -n "$expected" ] || fail "release $tag has no $asset"
  status=0
  fetch "$url/$asset" "$tmp" || status=$?
  if [ "$status" -eq 1 ]; then
    fail "release $tag lists $asset, but the server doesn't have it"
  elif [ "$status" -ne 0 ]; then
    fail "couldn't download $asset from $base: $why"
  fi
  actual=$(sha256 "$tmp" | tr 'A-F' 'a-f')
  if [ "$actual" != "$expected" ]; then
    fail "$asset failed its checksum (expected $expected, got $actual); nothing was installed"
  fi
  say "Checksum ok"

  chmod 755 "$tmp"
  mv -f "$tmp" "$dir/tokenhud"

  # ── report ─────────────────────────────────────────────────────────────────────────

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
}

main "$@"
