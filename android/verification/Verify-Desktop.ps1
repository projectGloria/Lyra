$ErrorActionPreference = 'Stop'
$taskAndroidRoot = Split-Path -Parent $PSScriptRoot
$taskDesktopRoot = Split-Path -Parent $taskAndroidRoot
$taskBefore = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-before.json') -Raw | ConvertFrom-Json
$taskAfter = @()
$taskChanged = @()
foreach ($taskEntry in $taskBefore) {
    $taskPath = Join-Path $taskDesktopRoot $taskEntry.path
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { $taskChanged += "Missing: $($taskEntry.path)"; continue }
    $taskHash = (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash
    $taskAfter += [PSCustomObject]@{path=$taskEntry.path; sha256=$taskHash}
    if ($taskHash -ne $taskEntry.sha256) { $taskChanged += "Changed: $($taskEntry.path)" }
}
$taskAfter | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-after.json') -Encoding utf8
$taskResult = [PSCustomObject]@{checkedFiles=$taskBefore.Count; changedFiles=$taskChanged.Count; changes=$taskChanged; excludedGeneratedDirectories=@('node_modules','src-tauri/target')}
$taskResult | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-integrity.json') -Encoding utf8
if ($taskChanged.Count -gt 0) { throw ($taskChanged -join "`n") }
Write-Output "Desktop integrity passed: $($taskBefore.Count) original source/config/assets/tests/review/archive files unchanged."
