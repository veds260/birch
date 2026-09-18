# Birch installer for Windows.
#
#   irm https://birch.video/install.ps1 | iex
#
# Read it before you run it. It puts Birch in %USERPROFILE%\.birch, adds a `birch`
# command, and opens the setup page in your browser, which does the rest with
# buttons. It never asks for administrator rights and writes nothing outside
# %USERPROFILE%\.birch except the one command folder and your PATH.

$ErrorActionPreference = 'Stop'

$dir = if ($env:BIRCH_DIR) { $env:BIRCH_DIR } else { Join-Path $env:USERPROFILE '.birch' }
$repo = if ($env:BIRCH_REPO) { $env:BIRCH_REPO } else { 'https://github.com/veds260/birch.git' }
$binDir = if ($env:BIRCH_BIN_DIR) { $env:BIRCH_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Birch\bin' }

function Say  ($m) { Write-Host ''; Write-Host "  $m" }
function Step ($m) { Write-Host "  $m" }
function Die  ($m) { Write-Host ''; Write-Host "  $m" -ForegroundColor Red; Write-Host ''; exit 1 }
function Have ($n) { $null -ne (Get-Command $n -ErrorAction SilentlyContinue) }

Say 'Installing Birch'

if ([Environment]::Is64BitOperatingSystem -eq $false) { Die 'Birch needs 64-bit Windows.' }

# ----- git -----
if (-not (Have git)) {
  if (Have winget) {
    Step 'installing git, this takes a couple of minutes'
    winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements --scope user | Out-Host
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Have git)) { Die 'git is missing. Install it from https://git-scm.com/download/win, open a new terminal, then run this again.' }
}

# ----- node 18 or newer -----
$nodeOk = $false
if (Have node) {
  $major = 0
  try { $major = [int](((node -p 'process.versions.node.split(".")[0]') | Out-String).Trim()) } catch {}
  if ($major -ge 18) { $nodeOk = $true }
  elseif ($major -gt 0) { Step "Node $major is too old, Birch needs 18 or newer" }
}
if (-not $nodeOk) {
  if (Have winget) {
    Step 'installing Node, this takes a couple of minutes'
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements | Out-Host
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (Have node)) { Die 'Birch needs Node 18 or newer. Install it from https://nodejs.org, open a new terminal, then run this again.' }
}

# ----- the code -----
if (Test-Path (Join-Path $dir '.git')) {
  Step "updating $dir"
  git -C $dir pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Die "Could not update $dir. Move it aside and run this again." }
} elseif (Test-Path $dir) {
  Die "$dir already exists and isn't Birch. Move it, or set BIRCH_DIR to somewhere else."
} else {
  Step "downloading into $dir"
  git clone --depth 1 --quiet $repo $dir
  if ($LASTEXITCODE -ne 0) { Die "Could not download $repo." }
}

# ----- the birch command -----
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir 'birch.cmd'
@"
@echo off
node "$dir\bin\birch" %*
"@ | Set-Content -Path $shim -Encoding ASCII
Step "the birch command is in $binDir"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDir).TrimStart(';'), 'User')
  Step 'added it to your PATH. Open a new terminal for it.'
}
$env:Path = $env:Path + ';' + $binDir

Say 'Opening Birch. The setup page walks you through the rest.'
& node "$dir\bin\birch"

Say 'Next time, just type: birch'
Step 'To use it from Claude Code or ChatGPT, press Add Birch on the setup page.'
Write-Host ''
