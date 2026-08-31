#!/usr/bin/env pwsh
#
# build-stage.ps1 - Step A of desktop packaging, Windows edition.
#
# The Windows counterpart of build-stage.sh. Assembles every runtime ingredient
# of a self-contained Windows openOpusClip app into `desktop-stage-win-x64/` at
# the repo root. Each step is idempotent and caches large downloads in
# `.desktop-build-cache/`.
#
# This MUST run on Windows. Not an arbitrary restriction: the stage contains a
# Windows CPython with compiled wheels (torch, mediapipe, opencv) and Windows
# ffmpeg binaries. Those can neither be assembled nor smoke-tested from macOS,
# which is why CI does it on a windows-latest runner
# (.github/workflows/desktop-windows.yml).
#
# Staged layout (mirrors the macOS stage; consumed by electron/main.js):
#   desktop-stage-win-x64/
#     dashboard/                 built Vite dashboard (copy of dashboard/dist)
#     backend/                   Python runtime source (app.py, main.py, ...)
#       dashboard/dist/          copy of the built dashboard (app.py mounts this)
#     render-service/dist/       compiled TS renderer (node dist/server.js)
#     render-service/node_modules  prod-only deps (@remotion/renderer + compositor, express; NO bundler)
#     remotion-bundle/           prebuilt Remotion bundle (REMOTION_PREBUILT_BUNDLE)
#     python/                    portable CPython 3.11 (python-build-standalone)
#     bin/                       ffmpeg.exe + ffprobe.exe + node.exe
#     chrome-headless-shell/     headless Chrome for Remotion rendering
#
# Usage:
#   pwsh -File scripts/desktop/build-stage.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Native commands don't throw on failure, they just set $LASTEXITCODE. Every
# one of them goes through Invoke-Native so a mid-build failure can't be
# mistaken for a successful stage.
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar is a large slowdown

function Write-Log  { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Info { param([string]$Message) Write-Host "    $Message" }
function Die        { param([string]$Message) Write-Host "ERROR: $Message" -ForegroundColor Red; exit 1 }

function Invoke-Native {
    param([Parameter(Mandatory)][scriptblock]$Command, [string]$What)
    & $Command
    if ($LASTEXITCODE -ne 0) { Die "$What failed (exit $LASTEXITCODE)" }
}

# --- 0. Guards ---------------------------------------------------------------

# Checked via $env:OS rather than $IsWindows on purpose: $IsWindows only exists
# in PowerShell 6+, and under Set-StrictMode reading it on Windows PowerShell
# 5.1 throws before this guard can produce a useful message.
if ($env:OS -ne 'Windows_NT') {
    Die "this staging pipeline only builds on Windows. Use scripts/desktop/build-stage.sh for macOS."
}
if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'x86')) {
    # ARM64 Windows can run the x64 stage under emulation, but the staged
    # binaries would still be x64 and we have not verified that path.
    Write-Info "NOTE: host is $env:PROCESSOR_ARCHITECTURE; this builds an x64 stage regardless."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir '..\..')).Path
$Stage     = Join-Path $RepoRoot 'desktop-stage-win-x64'
$Cache     = Join-Path $RepoRoot '.desktop-build-cache'
$TargetArch = 'x64'

New-Item -ItemType Directory -Force -Path $Stage, $Cache | Out-Null

# --- Pinned artifacts --------------------------------------------------------
# Every download is pinned to an exact version AND checksum. A moving "latest"
# URL would mean a stage that silently changes between builds, and a bad
# download would only surface as a crash on a user's machine.

# python-build-standalone CPython 3.11 (install_only), x86_64 Windows MSVC.
# Same release+version as the macOS stage, so both platforms ship one Python.
$PyRelease = '20260623'
$PyVersion = '3.11.15'
$PyTarball = "cpython-$PyVersion+$PyRelease-x86_64-pc-windows-msvc-install_only.tar.gz"
$PyUrl     = "https://github.com/astral-sh/python-build-standalone/releases/download/$PyRelease/$PyTarball"
$PySha256  = '7e0a8abfee952efc63dff290022a73f0185b586f522678ae7a757a56f23c289b'

# Static ffmpeg/ffprobe from BtbN/FFmpeg-Builds. The `-gpl` build is the one
# that carries libx264; `-shared` is deliberately NOT used (it splits the
# codecs into DLLs we would then have to stage alongside the exes).
# Pinned to ffmpeg 8.1.2, matching the macOS stage.
$FfmpegTag  = 'autobuild-2026-08-23-13-03'
$FfmpegName = 'ffmpeg-n8.1.2-44-g7c533d0f86-win64-gpl-8.1'
$FfmpegUrl  = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$FfmpegTag/$FfmpegName.zip"
$FfmpegSha256 = '40d98aef3e8d48665c4dbbdd0093d6e50c61d71a3a48067e9d3edd9fb3a1f3ca'

# Node.js, bundled purely so yt-dlp can solve YouTube's JS challenges.
#
# macOS gets this for free: Electron IS Node when launched with
# ELECTRON_RUN_AS_NODE=1, so a one-line `node` shell script on PATH is enough.
# Windows cannot do that. yt-dlp locates the runtime with a PATHEXT scan and
# then launches it through CreateProcess, which refuses to run a .cmd/.bat
# wrapper - so a shim is not an option and a real node.exe has to be staged.
# Must stay >= 22 (yt_dlp/utils/_jsruntime.py NodeJsRuntime.MIN_SUPPORTED_VERSION).
$NodeVersion = 'v24.19.0'
$NodeName    = "node-$NodeVersion-win-x64"
$NodeUrl     = "https://nodejs.org/dist/$NodeVersion/$NodeName.zip"
$NodeSha256  = '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73'

function Get-Pinned {
    <#  Download to the cache if absent, then verify the checksum every time -
        including on a cache hit, so a truncated or tampered cached file is
        caught rather than trusted forever.  #>
    param([string]$Url, [string]$Destination, [string]$Sha256)

    if (-not (Test-Path $Destination)) {
        Write-Info "downloading $(Split-Path -Leaf $Destination) ..."
        $tmp = "$Destination.tmp"
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
        Move-Item -Force $tmp $Destination
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $Destination).Hash.ToLower()
    if ($actual -ne $Sha256.ToLower()) {
        Die "sha256 mismatch for ${Destination}: got $actual, expected $Sha256"
    }
}

function Expand-Zip {
    # Expand-Archive is minutes slower than the framework call on archives this
    # size (the ffmpeg zip is ~168 MB, the Chrome one ~90 MB).
    param([string]$ZipPath, [string]$Destination)
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # Two-argument overload deliberately: the three-argument (overwrite) form
    # does not exist on Windows PowerShell 5.1's .NET Framework. Every caller
    # deletes the destination first, so there is nothing to overwrite.
    [System.IO.Compression.ZipFile]::ExtractToDirectory(
        (Resolve-Path $ZipPath).Path, (Resolve-Path $Destination).Path)
}

function Copy-Tree {
    # Replace the destination wholesale. Copy-Item -Recurse merges into an
    # existing folder instead of replacing it, which leaves stale files behind
    # from a previous build.
    param([string]$Source, [string]$Destination)
    if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -Recurse -Force $Source $Destination
}

function Get-FolderSizeMB {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return 0 }
    $bytes = (Get-ChildItem -Recurse -File -Force -ErrorAction SilentlyContinue $Path |
              Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) { return 0 }   # empty folder: Measure-Object returns no Sum
    return [math]::Round(($bytes / 1MB), 0)
}

# =============================================================================
Write-Log "Staging into: $Stage"

# --- a. Dashboard build ------------------------------------------------------
Write-Log 'a. Building dashboard (Vite)'
Push-Location (Join-Path $RepoRoot 'dashboard')
if (-not (Test-Path 'node_modules')) { Write-Info 'installing dashboard deps...'; Invoke-Native { npm install } 'npm install (dashboard)' }
# The dashboard bundles remotion source through the @remotion-src alias in
# dashboard/vite.config.js, so remotion's own deps must be installed BEFORE the
# Vite build, not later in step b. Without this a fresh clone fails with
# "Rollup failed to resolve import @remotion/lottie"; a machine that happened to
# have remotion/node_modules from earlier work built fine and hid the bug.
if (-not (Test-Path (Join-Path $RepoRoot 'remotion\node_modules'))) {
    Write-Info 'installing remotion deps...'
    Push-Location (Join-Path $RepoRoot 'remotion')
    Invoke-Native { npm install } 'npm install (remotion)'
    Pop-Location
}
# The desktop app always talks to the backend it starts itself on
# 127.0.0.1:8000 - force a relative API base so a VITE_API_URL left over in
# the shell or dashboard/.env can't get baked into the packaged dashboard.
$env:VITE_API_URL = ''
Invoke-Native { npm run build } 'dashboard build'
Remove-Item Env:\VITE_API_URL -ErrorAction SilentlyContinue
Pop-Location
Copy-Tree (Join-Path $RepoRoot 'dashboard\dist') (Join-Path $Stage 'dashboard')
Write-Info "dashboard -> $Stage\dashboard"

# --- b. Renderer code + prebuilt Remotion bundle -----------------------------
Write-Log 'b. Building renderer (tsc) + prebuilding Remotion bundle'
Push-Location (Join-Path $RepoRoot 'render-service')
if (-not (Test-Path 'node_modules')) { Write-Info 'installing render-service deps...'; Invoke-Native { npm install } 'npm install (render-service)' }
Invoke-Native { npm run build } 'render-service build'
Copy-Tree (Join-Path $RepoRoot 'render-service\dist') (Join-Path $Stage 'render-service\dist')
Write-Info "renderer dist -> $Stage\render-service\dist"

# Prebuild the Remotion bundle so the packaged app never imports @remotion/bundler.
$BundleDir = Join-Path $Stage 'remotion-bundle'
if (Test-Path $BundleDir) { Remove-Item -Recurse -Force $BundleDir }
Invoke-Native { npm run prebundle -- $BundleDir } 'remotion prebundle'
Pop-Location
if (-not (Test-Path (Join-Path $BundleDir 'index.html'))) { Die "prebundle produced no index.html at $BundleDir" }
Write-Info "remotion bundle -> $BundleDir"

# --- c. Renderer prod node_modules (no @remotion/bundler) --------------------
# See the macOS script for why @remotion/bundler is a devDependency: the packaged
# renderer runs against the prebuilt bundle via REMOTION_PREBUILT_BUNDLE and only
# needs @remotion/renderer (pure JS + the compositor subprocess).
Write-Log 'c. Installing renderer production node_modules (--omit=dev)'
Copy-Item -Force (Join-Path $RepoRoot 'render-service\package.json')      (Join-Path $Stage 'render-service\package.json')
Copy-Item -Force (Join-Path $RepoRoot 'render-service\package-lock.json') (Join-Path $Stage 'render-service\package-lock.json')
# Wipe first: npm ci prunes packages but can leave empty scope dirs (e.g. an
# @rspack/ husk from an interrupted run), which false-positive the guard below.
$StageNodeModules = Join-Path $Stage 'render-service\node_modules'
if (Test-Path $StageNodeModules) { Remove-Item -Recurse -Force $StageNodeModules }
Push-Location (Join-Path $Stage 'render-service')
Invoke-Native { npm ci --omit=dev --cpu=x64 --os=win32 } 'npm ci (staged render-service)'
Pop-Location

# Assert the expected shape. A missing compositor fails only at render time on
# the user's PC, which is exactly the failure we cannot afford to ship.
$Compositor = Join-Path $StageNodeModules '@remotion\compositor-win32-x64-msvc'
if (-not (Test-Path (Join-Path $StageNodeModules '@remotion\renderer'))) { Die 'stage missing @remotion/renderer' }
if (-not (Test-Path $Compositor)) { Die 'stage missing @remotion/compositor-win32-x64-msvc' }
if (-not (Test-Path (Join-Path $StageNodeModules 'express')))            { Die 'stage missing express' }
if (Test-Path (Join-Path $StageNodeModules '@remotion\bundler'))         { Die 'stage UNEXPECTEDLY contains @remotion/bundler' }
# Content check, not existence: npm 10 pre-creates EMPTY scope dirs for
# dev-omitted packages (e.g. @rspack/), which is harmless.
if (Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue (Join-Path $StageNodeModules '@rspack') | Select-Object -First 1) {
    Die 'stage UNEXPECTEDLY contains @rspack files (the bundler native addon)'
}
if (-not (Get-ChildItem -Recurse -File -Filter '*.exe' $Compositor | Select-Object -First 1)) {
    Die 'staged compositor has no .exe - npm resolved the wrong platform addon'
}
Write-Info 'prod node_modules OK: renderer + win32 compositor + express, no bundler/rspack'

# --- d. Portable Python + pip install requirements ---------------------------
Write-Log "d. Staging portable CPython $PyVersion + pip deps"
$PyCached = Join-Path $Cache $PyTarball
Get-Pinned -Url $PyUrl -Destination $PyCached -Sha256 $PySha256

$PyExe = Join-Path $Stage 'python\python.exe'
if (-not (Test-Path $PyExe)) {
    Write-Info 'extracting Python ...'
    $PyDir = Join-Path $Stage 'python'
    if (Test-Path $PyDir) { Remove-Item -Recurse -Force $PyDir }
    # Windows 10+ ships bsdtar as tar.exe, which reads .tar.gz natively.
    # The tarball extracts to a top-level "python\" dir.
    Invoke-Native { tar -xzf $PyCached -C $Stage } 'python tar extract'
}
if (-not (Test-Path $PyExe)) { Die "portable python missing at $PyExe" }
Write-Info "python: $(& $PyExe --version)"

Write-Info 'pip install -r requirements.txt (all Python runtime dependencies; may be slow) ...'
Invoke-Native { & $PyExe -m pip install --upgrade pip --quiet } 'pip self-upgrade'
Invoke-Native { & $PyExe -m pip install -r (Join-Path $RepoRoot 'requirements.txt') } 'pip install requirements'

# Keep the complete pip-resolved runtime. These packages are not optional from
# the installer's point of view: faster-whisper, mediapipe, ultralytics and
# torch all declare dependencies that are loaded lazily on real code paths.
# Removing them made `pip check` fail and let the installer ship an app that
# launched successfully but crashed only when a feature was exercised.
Write-Log 'd2. Verifying Python dependency graph and removing only debug symbols'
$PyDir = Join-Path $Stage 'python'
$before = Get-FolderSizeMB $PyDir
$PipCheckOutput = @(& $PyExe -m pip check 2>&1)
if ($LASTEXITCODE -ne 0) {
    # Mirror the macOS check so both stage builders tolerate the same known
    # MediaPipe wheel-label message; the native smoke test below verifies the
    # runtime itself.
    $UnexpectedPipCheck = @($PipCheckOutput | Where-Object {
        $_ -notmatch '^mediapipe [^ ]+ is not supported on this platform$'
    })
    if ($UnexpectedPipCheck.Count -gt 0) {
        $PipCheckOutput | ForEach-Object { Write-Host $_ }
        Die 'Python dependency check failed'
    }
    Write-Info 'pip check: ignored the known universal2 MediaPipe wheel-label warning'
} else {
    Write-Info 'pip check: all installed dependencies are satisfied'
}
# The .pdb files are Windows-only dead weight: python-build-standalone ships
# debug symbols for every .pyd, which nothing in a released app can use.
Get-ChildItem -Path $PyDir -Recurse -File -Filter '*.pdb' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
$after = Get-FolderSizeMB $PyDir
Write-Info "python runtime: $before MB -> $after MB"

Write-Info 'smoke-testing backend imports and native runtime paths ...'
# The helper exercises the ONNX-backed VAD model as well as the backend modules.
$SmokeFile = Join-Path $env:TEMP 'openopusclip-smoke.py'
Copy-Item -Force (Join-Path $ScriptDir 'smoke-python-runtime.py') $SmokeFile
$env:PYTHONPATH = "$RepoRoot" + $(if ($env:PYTHONPATH) { ";$($env:PYTHONPATH)" } else { '' })
Invoke-Native { & $PyExe $SmokeFile } 'python runtime smoke test'
Remove-Item -Force $SmokeFile -ErrorAction SilentlyContinue

# --- e. Backend source -------------------------------------------------------
Write-Log 'e. Staging backend Python source + fonts'
$Backend = Join-Path $Stage 'backend'
New-Item -ItemType Directory -Force -Path $Backend | Out-Null
# Exact set of local modules the app imports (grep-verified in app.py/main.py/etc.).
foreach ($f in @('app.py', 'main.py', 'editor.py', 'gemini_models.py',
                 'transcription.py', 'transcription_worker.py', 'thumbnail.py', 's3_uploader.py',
                 'ffmpeg_utils.py', 'requirements.txt')) {
    Copy-Item -Force (Join-Path $RepoRoot $f) (Join-Path $Backend $f)
}
# app.py mounts <module dir>/dashboard/dist as the SPA root.
Copy-Tree (Join-Path $Stage 'dashboard') (Join-Path $Backend 'dashboard\dist')
Write-Info "backend -> $Backend (modules + fonts + dashboard/dist)"

# --- f. Static ffmpeg + ffprobe ----------------------------------------------
Write-Log 'f. Staging static ffmpeg + ffprobe (x64)'
$BinDir = Join-Path $Stage 'bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$FfmpegZip = Join-Path $Cache "$FfmpegName.zip"
Get-Pinned -Url $FfmpegUrl -Destination $FfmpegZip -Sha256 $FfmpegSha256
$FfExtract = Join-Path $Cache "ffmpeg-extract-$FfmpegName"
if (Test-Path $FfExtract) { Remove-Item -Recurse -Force $FfExtract }
Expand-Zip -ZipPath $FfmpegZip -Destination $FfExtract
# The zip nests everything under <build-name>/bin/. Only ffmpeg + ffprobe are
# staged; ffplay is a GUI player the app never invokes and is ~146 MB.
Copy-Item -Force (Join-Path $FfExtract "$FfmpegName\bin\ffmpeg.exe")  (Join-Path $BinDir 'ffmpeg.exe')
Copy-Item -Force (Join-Path $FfExtract "$FfmpegName\bin\ffprobe.exe") (Join-Path $BinDir 'ffprobe.exe')
Remove-Item -Recurse -Force $FfExtract

# Verify: runnable, and libx264 actually encodes. There is no Windows equivalent
# of the macOS videotoolbox check - ffmpeg_utils.py only enables hardware
# encoding on Darwin, so every Windows encode goes through libx264 and that is
# the one encoder that has to work.
$ffmpeg = Join-Path $BinDir 'ffmpeg.exe'
Invoke-Native { & $ffmpeg -version | Out-Null } 'staged ffmpeg -version'
Invoke-Native { & (Join-Path $BinDir 'ffprobe.exe') -version | Out-Null } 'staged ffprobe -version'
if (-not (& $ffmpeg -hide_banner -encoders 2>$null | Select-String -SimpleMatch 'libx264')) {
    Die 'staged ffmpeg lacks libx264'
}
$FfTest = Join-Path $env:TEMP 'openopusclip-x264-test.mp4'
Invoke-Native {
    & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 `
        -c:v libx264 -pix_fmt yuv420p $FfTest
} 'libx264 test encode'
Remove-Item -Force $FfTest -ErrorAction SilentlyContinue
Write-Info 'ffmpeg/ffprobe verified: x64, libx264 encodes'

# --- f2. node.exe for yt-dlp -------------------------------------------------
Write-Log "f2. Staging Node $NodeVersion (yt-dlp JS runtime)"
$NodeZip = Join-Path $Cache "$NodeName.zip"
Get-Pinned -Url $NodeUrl -Destination $NodeZip -Sha256 $NodeSha256
$NodeExtract = Join-Path $Cache "node-extract-$NodeVersion"
if (Test-Path $NodeExtract) { Remove-Item -Recurse -Force $NodeExtract }
Expand-Zip -ZipPath $NodeZip -Destination $NodeExtract
# Only node.exe is staged. The rest of the zip is npm/corepack, which the
# packaged app never runs.
Copy-Item -Force (Join-Path $NodeExtract "$NodeName\node.exe") (Join-Path $BinDir 'node.exe')
Remove-Item -Recurse -Force $NodeExtract
$stagedNodeVersion = (& (Join-Path $BinDir 'node.exe') --version).Trim()
if ($stagedNodeVersion -ne $NodeVersion) { Die "staged node reports $stagedNodeVersion, expected $NodeVersion" }
# yt-dlp refuses anything below 22 and silently falls back to a slower path.
$nodeMajor = [int]($stagedNodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Die "staged node is $stagedNodeVersion; yt-dlp needs >= 22" }
Write-Info "node -> $BinDir\node.exe ($stagedNodeVersion)"

# --- g. chrome-headless-shell ------------------------------------------------
Write-Log 'g. Staging chrome-headless-shell'
# Read Remotion's pinned Chrome version straight from the installed renderer so
# the two can never drift. Forward slashes: Node accepts them on Windows and
# they avoid escaping backslashes inside the require() string.
$rendererEntry = ((Join-Path $RepoRoot 'remotion\node_modules\@remotion\renderer\dist\browser\get-chrome-download-url.js') -replace '\\', '/')
$ChromeVersion = (& node -p "require('$rendererEntry').TESTED_VERSION" 2>$null)
if ([string]::IsNullOrWhiteSpace($ChromeVersion)) { Die "could not read Remotion's pinned Chrome version (TESTED_VERSION)" }
$ChromeVersion = $ChromeVersion.Trim()
Write-Info "Remotion pins Chrome $ChromeVersion"

# Downloaded directly from Chrome-for-Testing rather than via `remotion browser
# ensure`, so the staged browser is the pinned version whatever the local
# Remotion cache happens to hold. No checksum to pin here: the version is
# resolved at build time from Remotion, not hardcoded.
$ChromeZip = Join-Path $Cache "chrome-headless-shell-win64-$ChromeVersion.zip"
if (-not (Test-Path $ChromeZip)) {
    Write-Info "downloading chrome-headless-shell $ChromeVersion (win64) ..."
    $tmp = "$ChromeZip.tmp"
    Invoke-WebRequest -UseBasicParsing -OutFile $tmp `
        -Uri "https://storage.googleapis.com/chrome-for-testing-public/$ChromeVersion/win64/chrome-headless-shell-win64.zip"
    Move-Item -Force $tmp $ChromeZip
}
$ChromeDir = Join-Path $Stage 'chrome-headless-shell'
if (Test-Path $ChromeDir) { Remove-Item -Recurse -Force $ChromeDir }
# The zip contains a chrome-headless-shell-win64/ top level, which is exactly
# the layout electron/main.js expects under the staged dir.
Expand-Zip -ZipPath $ChromeZip -Destination $ChromeDir
$StagedShell = Join-Path $ChromeDir 'chrome-headless-shell-win64\chrome-headless-shell.exe'
if (-not (Test-Path $StagedShell)) { Die "staged chrome-headless-shell.exe not found at $StagedShell" }
Write-Info "chrome-headless-shell -> $StagedShell"

# --- h. Size report ----------------------------------------------------------
Write-Log 'h. Stage size report'
foreach ($d in @('dashboard', 'backend', 'render-service', 'remotion-bundle', 'python', 'bin', 'chrome-headless-shell')) {
    $p = Join-Path $Stage $d
    if (Test-Path $p) { Write-Host ("    {0,-22} {1} MB" -f $d, (Get-FolderSizeMB $p)) }
}
Write-Host ("    {0,-22} {1} MB" -f 'TOTAL', (Get-FolderSizeMB $Stage))

Write-Log "Stage build complete: $Stage ($TargetArch)"
Write-Host 'Next: cd electron && npm run package:win'
