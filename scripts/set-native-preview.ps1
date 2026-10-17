param(
  [Parameter(Mandatory=$true,ParameterSetName='Enable')]
  [switch]$Enable,
  [Parameter(Mandatory=$true,ParameterSetName='Disable')]
  [switch]$Disable,
  [string]$Profile = 'web',
  [string]$DshHome = (Join-Path $HOME '.dsh')
)
$ErrorActionPreference='Stop'
if ($Profile -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid DSH profile name' }
$dir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$file = Join-Path $dir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Profile patch not found: $file" }
$raw=[System.IO.File]::ReadAllText($file)
$start='# BEGIN DSH-AGY NATIVE PREVIEW SETTING'
$end='# END DSH-AGY NATIVE PREVIEW SETTING'
$enabledValue=if($Enable){'true'}else{'false'}
$block=("$start`r`n" +
  "- id: dsh-subagent-agy-reviewed`r`n" +
  "  name: '@dsh-external/dsh-subagent-agy-reviewed'`r`n" +
  "  config:`r`n" +
  "    nativeContinuableEnabled: $enabledValue`r`n" +
  "$end")
$quoted=[regex]::Escape($start)+ '[\s\S]*?' +[regex]::Escape($end)
if ($raw.Contains($start)) {
  $replacementCount=[regex]::Matches($raw,$quoted).Count
  if($replacementCount -ne 1){throw "Existing AGY preview setting block is malformed; refusing to modify $file"}
  $updated=[regex]::Replace($raw,$quoted,[System.Text.RegularExpressions.MatchEvaluator]{param($m) $block})
} else {
  if ($raw -match '(?m)^- id: dsh-subagent-agy-reviewed\s*$') {
    throw "Another AGY configuration entry exists; refusing to create a duplicate. Inspect $file"
  }
  $updated=$raw.TrimEnd("`r","`n") + "`r`n" + $block + "`r`n"
}
if ($updated -eq $raw) {Write-Output "No change needed: $enabledValue";exit 0}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup=$file+'.agy-backup-'+$stamp
Copy-Item -LiteralPath $file -Destination $backup -ErrorAction Stop
# Preserve UTF8 without BOM; this script affects only the chosen profile patch.
[System.IO.File]::WriteAllText($file,$updated,(New-Object System.Text.UTF8Encoding($false)))
Write-Output "AGY native continuable enabled=$enabledValue"
Write-Output "Profile=$Profile"
Write-Output "Backup=$backup"
Write-Output 'Restart the matching DSH backend; a UI refresh alone does not reload the plugin.'
