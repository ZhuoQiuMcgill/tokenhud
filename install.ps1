# Installs tokenhud on Windows: downloads the release binary for this machine from GitHub
# Releases, checks its SHA-256 against the release's SHA256SUMS, puts it in
# %LOCALAPPDATA%\tokenhud\bin and adds that folder to your user PATH. No admin rights.
# Safe to run again: it reinstalls, or updates to the newest release.
#
#   irm https://raw.githubusercontent.com/ZhuoQiuMcgill/tokenhud/main/install.ps1 | iex
#
# Environment:
#   TOKENHUD_VERSION         a release to install, e.g. 0.1.0 or v0.1.0-rc.1 (default: the
#                            latest stable release)
#   TOKENHUD_INSTALL         the folder to install into (default: %LOCALAPPDATA%\tokenhud\bin)
#   TOKENHUD_NO_MODIFY_PATH  set to 1 to leave the user PATH alone
#   TOKENHUD_DOWNLOAD_BASE   where releases are downloaded from (default: the repository's
#                            GitHub Releases); for testing against a local copy
#
# Errors are thrown, never `exit`: piped into iex, exit would close the user's shell.

function Install-Tokenhud {
  $ErrorActionPreference = 'Stop'
  # Invoke-WebRequest's progress bar slows downloads to a crawl on Windows PowerShell 5.1.
  $ProgressPreference = 'SilentlyContinue'
  # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'ZhuoQiuMcgill/tokenhud'
  $base = if ($env:TOKENHUD_DOWNLOAD_BASE) { $env:TOKENHUD_DOWNLOAD_BASE.TrimEnd('/') }
          else { "https://github.com/$repo/releases" }
  $dir = if ($env:TOKENHUD_INSTALL) { $env:TOKENHUD_INSTALL }
         else { Join-Path $env:LOCALAPPDATA 'tokenhud\bin' }
  $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dir).TrimEnd('\')

  # The OS's architecture, not this process's: 32-bit or emulated PowerShell misreports it.
  $arch = $null
  try {
    $arch = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  } catch {}
  if (-not $arch) {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 }
            else { $env:PROCESSOR_ARCHITECTURE }
  }
  switch -Regex ($arch) {
    '^(X64|AMD64)$' { $arch = 'x64'; break }
    '^ARM64$' { $arch = 'arm64'; break }
    default { throw "tokenhud install: no tokenhud binary for the $arch architecture" }
  }
  $asset = "tokenhud-windows-$arch.exe"

  if ($env:TOKENHUD_VERSION) {
    $tag = 'v' + $env:TOKENHUD_VERSION.TrimStart('v')
    $url = "$base/download/$tag"
  } else {
    $tag = 'the latest release'
    $url = "$base/latest/download"
  }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $exe = Join-Path $dir 'tokenhud.exe'
  # Staged beside the target, so putting it in place is a rename on the same volume.
  $tmp = Join-Path $dir ("tokenhud-install-$PID.exe")
  try {
    Write-Host "Downloading $asset ($tag)"
    try {
      $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS").Content
    } catch {
      $why = $_.Exception.Message
      if ($env:TOKENHUD_VERSION) { throw "tokenhud install: release $tag not found at $base ($why)" }
      throw "tokenhud install: no stable release found at $base ($why); pick one with TOKENHUD_VERSION"
    }
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $expected = $null
    foreach ($line in ($sums -split "`r?`n")) {
      if ($line -match '^([0-9A-Fa-f]{64}) [ *](.+)$' -and $Matches[2] -eq $asset) {
        $expected = $Matches[1].ToLowerInvariant()
        break
      }
    }
    if (-not $expected) { throw "tokenhud install: release $tag has no $asset" }

    Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile $tmp
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "tokenhud install: $asset failed its checksum (expected $expected, got $actual); nothing was installed"
    }
    Write-Host 'Checksum ok'

    # A running tokenhud.exe (the TUI, or an MCP server) can't be overwritten, but it can be
    # renamed; tokenhud deletes the parked copy the next time it starts.
    if (Test-Path -LiteralPath $exe) {
      $parked = "$exe.old"
      try {
        Remove-Item -LiteralPath $parked -Force -ErrorAction Stop
      } catch [System.Management.Automation.ItemNotFoundException] {
      } catch {
        $parked = "$exe.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).old"
      }
      Move-Item -LiteralPath $exe -Destination $parked -Force
      try {
        Move-Item -LiteralPath $tmp -Destination $exe -Force
      } catch {
        Move-Item -LiteralPath $parked -Destination $exe -Force
        throw
      }
      Remove-Item -LiteralPath $parked -Force -ErrorAction SilentlyContinue
    } else {
      Move-Item -LiteralPath $tmp -Destination $exe -Force
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }

  $installed = & $exe --version
  if ($LASTEXITCODE -ne 0) { throw "tokenhud install: installed $exe, but it doesn't start" }
  Write-Host "Installed $installed to $exe"

  # The user PATH is read and written in the registry as it is stored, so entries such as
  # %USERPROFILE%\bin stay unexpanded ([Environment]::SetEnvironmentVariable would expand them).
  $env_ = 'Environment'
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env_)
  $userPath = if ($key) {
    [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } else { '' }
  if ($key) { $key.Close() }
  $entries = @($userPath -split ';' | Where-Object { $_ } |
    ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
  if ($entries -contains $dir) {
    # Already there.
  } elseif ($env:TOKENHUD_NO_MODIFY_PATH -eq '1') {
    Write-Host ''
    Write-Host "$dir is not on your PATH. Add it to run tokenhud from anywhere."
  } else {
    $newPath = if ($userPath) { "$($userPath.TrimEnd(';'));$dir" } else { $dir }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env_)
    try {
      $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    } finally {
      $key.Close()
    }
    # Setting any user variable broadcasts the change, so new terminals see the new PATH.
    [Environment]::SetEnvironmentVariable('TOKENHUD_INSTALL_PATH_CHANGED', '1', 'User')
    [Environment]::SetEnvironmentVariable('TOKENHUD_INSTALL_PATH_CHANGED', $null, 'User')
    $env:Path = "$env:Path;$dir"
    Write-Host ''
    Write-Host "Added $dir to your user PATH. Terminals opened from now on will find tokenhud."
  }
  Write-Host ''
  Write-Host 'Run tokenhud to start. Update later with: tokenhud update'
}

Install-Tokenhud
