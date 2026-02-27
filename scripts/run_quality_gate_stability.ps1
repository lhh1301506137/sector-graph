param(
    [int]$Runs = 3,
    [int]$IntervalSec = 60,
    [string]$Source = "sina",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 18001,
    [switch]$SkipRefresh
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if ($Runs -lt 1) {
    throw "Runs must be >= 1"
}
if ($IntervalSec -lt 0) {
    throw "IntervalSec must be >= 0"
}

$reportsDir = Join-Path $root "reports"
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir | Out-Null
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$summaryPath = Join-Path $reportsDir ("quality_gate_stability_{0}.json" -f $stamp)
$summaryLogPath = Join-Path $reportsDir ("quality_gate_stability_{0}.log" -f $stamp)

$runner = Join-Path $root "scripts/run_quality_gate_acceptance.ps1"
$allPassed = $true
$runsResult = @()

for ($i = 1; $i -le $Runs; $i++) {
    Write-Host ("[INFO] Stability run {0}/{1}..." -f $i, $Runs)
    $startAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    $output = & $runner -Source $Source -BindHost $BindHost -Port $Port -SkipRefresh:$SkipRefresh 2>&1
    $exitCode = $LASTEXITCODE
    $outputText = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    $output | Tee-Object -FilePath $summaryLogPath -Append | Out-Null

    $reportPath = ""
    $latestReport = Get-ChildItem -Path $reportsDir -Filter "quality_gate_acceptance_*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($latestReport) {
        $reportPath = $latestReport.FullName
    }

    $runPassed = $exitCode -eq 0
    if (-not $runPassed) {
        $allPassed = $false
    }

    $runsResult += [ordered]@{
        run_no = $i
        started_at = $startAt
        exit_code = $exitCode
        passed = $runPassed
        report_path = $reportPath
    }

    if ($i -lt $Runs -and $IntervalSec -gt 0) {
        Write-Host ("[INFO] Waiting {0}s before next run..." -f $IntervalSec)
        Start-Sleep -Seconds $IntervalSec
    }
}

$summary = [ordered]@{
    stage = "api_pull_to_quality_gate"
    generated_at = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    runs = $Runs
    interval_sec = $IntervalSec
    all_passed = $allPassed
    items = $runsResult
    log_path = $summaryLogPath
}

$summary | ConvertTo-Json -Depth 20 | Out-File -FilePath $summaryPath -Encoding utf8

Write-Host "[INFO] Stability summary: $summaryPath"
Write-Host "[INFO] Stability log: $summaryLogPath"
if ($allPassed) {
    Write-Host "[PASS] quality gate stability"
    exit 0
}

Write-Host "[FAIL] quality gate stability"
exit 1
