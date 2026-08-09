#!/usr/bin/env pwsh
#
# Self-check for the helper functions in build-stage.ps1.
#
# The staging script itself can only be exercised on Windows and takes ~30
# minutes. Its helpers are cross-platform and are where a silent bug actually
# costs something - a checksum that never compares, or a Copy-Tree that merges
# into a stale folder and ships last build's files. This runs anywhere
# PowerShell does, in about a second.
#
#   pwsh -File scripts/desktop/test-build-stage-helpers.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$StageScript = Join-Path $ScriptDir 'build-stage.ps1'

# Pull the function definitions out of build-stage.ps1 without running it (the
# script body starts downloading a 2 GB runtime). Parsing for
# FunctionDefinitionAst keeps the test honest: it tests the real definitions,
# not a copy that can drift.
$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($StageScript, [ref]$tokens, [ref]$errors)
if ($errors) {
    $errors | ForEach-Object { Write-Host ("{0}:{1}  {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message) }
    throw "build-stage.ps1 does not parse"
}
$funcs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($f in $funcs) { . ([scriptblock]::Create($f.Extent.Text)) }

$failures = @()
function Assert {
    param([string]$Name, [bool]$Condition)
    if ($Condition) { Write-Host "  ok   $Name" }
    else { Write-Host "  FAIL $Name" -ForegroundColor Red; $script:failures += $Name }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("openopusclip-helpers-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    Write-Host "`nInvoke-Native"
    # A native command that fails must stop the build. Die calls exit, so the
    # failure case runs in a child process and we check its exit code.
    $child = Join-Path $tmp 'fail.ps1'
    @"
`$ErrorActionPreference = 'Stop'
$($funcs.Where({ $_.Name -in 'Die', 'Invoke-Native' }).Extent.Text -join "`n")
Invoke-Native { & "$((Get-Process -Id $PID).Path)" -NoProfile -Command 'exit 3' } 'deliberate failure'
Write-Host 'REACHED-END'
"@ | Set-Content -Path $child -Encoding UTF8
    $out = & (Get-Process -Id $PID).Path -NoProfile -File $child 2>&1 | Out-String
    Assert 'non-zero exit stops the build' ($LASTEXITCODE -eq 1 -and $out -notmatch 'REACHED-END')
    Assert 'failure message names the step' ($out -match 'deliberate failure')

    $ok = $true
    try { Invoke-Native { & (Get-Process -Id $PID).Path -NoProfile -Command 'exit 0' } 'ok step' }
    catch { $ok = $false }
    Assert 'zero exit passes through' $ok

    Write-Host "`nGet-Pinned"
    $payload = Join-Path $tmp 'payload.bin'
    Set-Content -Path $payload -Value 'openopusclip' -NoNewline -Encoding ASCII
    $realHash = (Get-FileHash -Algorithm SHA256 -Path $payload).Hash

    # Cache hit with the right hash: verifies without re-downloading (the URL
    # below is unreachable on purpose - reaching it would mean the cache check
    # was skipped).
    $verified = $true
    try { Get-Pinned -Url 'https://0.0.0.0/never' -Destination $payload -Sha256 $realHash }
    catch { $verified = $false }
    Assert 'cached file with matching checksum is accepted' $verified

    # The one that matters: a cached file must be re-verified every run, not
    # trusted because it exists. Mismatch has to be fatal.
    $child2 = Join-Path $tmp 'mismatch.ps1'
    @"
`$ErrorActionPreference = 'Stop'
$($funcs.Where({ $_.Name -in 'Die', 'Write-Info', 'Get-Pinned' }).Extent.Text -join "`n")
Get-Pinned -Url 'https://0.0.0.0/never' -Destination '$payload' -Sha256 ('0' * 64)
Write-Host 'REACHED-END'
"@ | Set-Content -Path $child2 -Encoding UTF8
    $out2 = & (Get-Process -Id $PID).Path -NoProfile -File $child2 2>&1 | Out-String
    Assert 'cached file with wrong checksum is rejected' ($out2 -match 'sha256 mismatch' -and $out2 -notmatch 'REACHED-END')

    Write-Host "`nCopy-Tree"
    $src = Join-Path $tmp 'src'
    $dst = Join-Path $tmp 'nested\dst'
    New-Item -ItemType Directory -Force -Path $src | Out-Null
    Set-Content -Path (Join-Path $src 'keep.txt') -Value 'v2' -Encoding ASCII
    # Seed the destination with a file that no longer exists in the source. A
    # plain Copy-Item -Recurse would merge and leave it behind; that stale file
    # is how a stage ships a deleted module.
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Set-Content -Path (Join-Path $dst 'stale.txt') -Value 'old' -Encoding ASCII

    Copy-Tree -Source $src -Destination $dst
    Assert 'copies source contents'      (Test-Path (Join-Path $dst 'keep.txt'))
    Assert 'removes stale destination files' (-not (Test-Path (Join-Path $dst 'stale.txt')))
    Assert 'creates missing parent dirs'  (Test-Path (Split-Path -Parent $dst))

    Write-Host "`nGet-FolderSizeMB"
    Assert 'empty folder is 0 MB' ((Get-FolderSizeMB (Join-Path $tmp 'nested\empty-does-not-exist')) -eq 0)
    $big = Join-Path $tmp 'big'
    New-Item -ItemType Directory -Force -Path $big | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $big 'blob'), (New-Object byte[] (3 * 1024 * 1024)))
    Assert '3 MB file measures as 3 MB' ((Get-FolderSizeMB $big) -eq 3)
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host "$($failures.Count) check(s) failed" -ForegroundColor Red
    exit 1
}
Write-Host 'all build-stage.ps1 helper checks passed' -ForegroundColor Green
