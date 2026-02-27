param(
    [string]$Source = "sina",
    [string]$BaseUrl = "http://127.0.0.1:18000",
    [switch]$StartServer,
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 18001,
    [switch]$SkipRefresh,
    [switch]$ExerciseBlockedCase,
    [switch]$ExerciseFailedRowsCase,
    [ValidateSet("auto", "true", "false")]
    [string]$ExpectPublishAllowed = "auto"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Test-PythonHasUvicorn {
    param([string]$Candidate)
    try {
        if ($Candidate -eq "py") {
            & py -3 -c "import uvicorn" *> $null
        } else {
            & $Candidate -c "import uvicorn" *> $null
        }
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

$candidates = @()
$localVenv = Join-Path $root ".venv-win\Scripts\python.exe"
$legacyVenv = Join-Path $root "venv\Scripts\python.exe"
$miniConda = Join-Path $env:USERPROFILE "miniconda3\python.exe"
$anaconda = Join-Path $env:USERPROFILE "anaconda3\python.exe"
if (Test-Path $localVenv) { $candidates += $localVenv }
if (Test-Path $legacyVenv) { $candidates += $legacyVenv }
if (Test-Path $miniConda) { $candidates += $miniConda }
if (Test-Path $anaconda) { $candidates += $anaconda }
if (Get-Command python -ErrorAction SilentlyContinue) { $candidates += "python" }
if (Get-Command py -ErrorAction SilentlyContinue) { $candidates += "py" }

$pyExe = $null
foreach ($cand in $candidates) {
    if (Test-PythonHasUvicorn -Candidate $cand) {
        $pyExe = $cand
        break
    }
}

if (-not $pyExe) {
    throw "No Python interpreter with uvicorn found. Please install deps in venv/miniconda."
}

$argsList = @("scripts/quality_gate_smoke.py")
if ($StartServer) {
    $argsList += @("--start-server", "--host", $BindHost, "--port", "$Port")
} else {
    $argsList += @("--base-url", $BaseUrl)
}
$argsList += @("--source", $Source, "--expect-publish-allowed", $ExpectPublishAllowed)
if ($SkipRefresh) {
    $argsList += "--skip-refresh"
}
if ($ExerciseBlockedCase) {
    $argsList += "--exercise-blocked-case"
}
if ($ExerciseFailedRowsCase) {
    $argsList += "--exercise-failed-rows-case"
}

Write-Host "[INFO] Running quality gate smoke test..."
if ($pyExe -eq "py") {
    & py -3 @argsList
} else {
    & $pyExe @argsList
}
