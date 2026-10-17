<#
.SYNOPSIS
  Stage a real directory for the DSH Desktop local-file plugin manager.
.DESCRIPTION
  DSH Desktop's startup recovery may purge a file:<archive>.tgz dependency
  as a dangling local link. This script creates a persistent directory-based
  package instead. It only writes under F:/agy-subagebt (repository root).
  It never touches the active DSH profile. Running dsh plugin add is left
  to the user, to avoid clobbering live plugin-manager operations.
#>
param(
  [switch]$SkipBuild,
  [ValidatePattern('^[A-Za-z0-9_.-]+$')]
  [string]$StageName = 'dsh-subagent-agy-reviewed'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stage = Join-Path (Join-Path $root 'deploy') $StageName
$tmp = Join-Path $root ('deploy\.agy-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  Push-Location $root
  try {
    if (-not $SkipBuild) {
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed' }
    }
    & npm.cmd pack --ignore-scripts --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
  } finally {
    Pop-Location
  }
  $metadata = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $filename = (($metadata.name -replace '^@', '' -replace '/', '-') + '-' + $metadata.version + '.tgz')
  $archive = Join-Path $root $filename
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "Package archive not found: $archive"
  }
  # Prefer Windows bsdtar: a GNU tar earlier on PATH (Git/MSYS) parses 'F:' as a remote host.
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tarExe)) { $tarExe = 'tar' }
  & $tarExe -xf $archive -C $tmp
  if ($LASTEXITCODE -ne 0) { throw 'Tar archive extraction failed' }
  $unpacked = Join-Path $tmp 'package'
  $package = Join-Path $unpacked 'package.json'
  if (-not (Test-Path $package)) { throw 'No package.json in archive' }
  $j = Get-Content $package -Raw | ConvertFrom-Json
  if ($j.name -ne '@dsh-external/dsh-subagent-agy-reviewed' -or $j.version -ne $metadata.version) {
    throw 'Unexpected package identity; refusing deployment'
  }
  if (-not (Test-Path (Join-Path $unpacked 'lib\index.js')) -or
      -not (Test-Path (Join-Path $unpacked 'lib\native-bridge.js'))) {
    throw 'Compiled native bridge files missing'
  }
  $patch = Get-Content (Join-Path $unpacked 'cordis.patch.yml') -Raw
  if ($patch -notmatch '(?m)^\s+nativeContinuableEnabled:\s*true\s*$') {
    throw 'Native preview is not enabled in the staged package'
  }
  if (Test-Path $stage) {
    # Never replace the currently installed live junction target: Node can
    # still be executing from this directory. Stage a distinct path instead.
    $profilePackage = Join-Path (Join-Path $HOME '.dsh\profiles\web\node_modules\@dsh-external') 'dsh-subagent-agy-reviewed'
    $installed = Get-Item $profilePackage -Force -ErrorAction SilentlyContinue
    if ($installed -and $installed.Target) {
      $linked = @($installed.Target)[0]
      if ([string]::Equals(([System.IO.Path]::GetFullPath($linked)).TrimEnd('\'), ([System.IO.Path]::GetFullPath($stage)).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace the live installed plugin at $stage; use -StageName dsh-subagent-agy-reviewed-hotfix"
      }
    }
    # Preserve the old package in a backup directory instead of deleting it.
    $backup = $stage + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item $stage $backup
    Write-Output "Previous deployment backup: $backup"
  }
  Move-Item $unpacked $stage
  Write-Output "STAGED=$stage"
  Write-Output "PACKAGE=$($j.name)@$($j.version)"
  Write-Output 'Use a *directory* install, not the tgz:'
  Write-Output ('dsh plugin --profile web add "' + $stage + '"')
  Write-Output 'Do not install while a concurrent plugin-marketplace operation is running.'
  Write-Output 'Restart the DSH Desktop backend after installation, then verify the plugin remains present.'
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
}
