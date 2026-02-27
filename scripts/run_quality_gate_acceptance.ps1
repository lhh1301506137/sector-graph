param(
    [string]$Source = "sina",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 18001,
    [switch]$SkipRefresh
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$reportsDir = Join-Path $root "reports"
if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Path $reportsDir | Out-Null
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logPath = Join-Path $reportsDir ("quality_gate_acceptance_{0}.log" -f $stamp)
$reportPath = Join-Path $reportsDir ("quality_gate_acceptance_{0}.json" -f $stamp)

$runner = Join-Path $root "scripts/run_quality_gate_smoke.ps1"
$runnerParams = @{
    StartServer = $true
    BindHost = $BindHost
    Port = $Port
    Source = $Source
    ExerciseBlockedCase = $true
    ExerciseFailedRowsCase = $true
}
if ($SkipRefresh) {
    $runnerParams.SkipRefresh = $true
}

$output = & $runner @runnerParams 2>&1
$exitCode = $LASTEXITCODE
$output | Tee-Object -FilePath $logPath

$outputText = ($output | ForEach-Object { $_.ToString() }) -join "`n"
$smokePass = ($exitCode -eq 0) -and ($outputText -match "\[PASS\]\s+quality gate smoke test")

$summary = $null
$fallbackSummary = $null
$openIndexes = @()
for ($i = 0; $i -lt $outputText.Length; $i++) {
    if ($outputText[$i] -eq '{') {
        $openIndexes += $i
    }
}
for ($s = $openIndexes.Count - 1; $s -ge 0; $s--) {
    $start = $openIndexes[$s]
    $depth = 0
    for ($j = $start; $j -lt $outputText.Length; $j++) {
        if ($outputText[$j] -eq '{') {
            $depth++
        } elseif ($outputText[$j] -eq '}') {
            $depth--
            if ($depth -eq 0) {
                $jsonText = $outputText.Substring($start, $j - $start + 1).Trim()
                try {
                    $parsed = $jsonText | ConvertFrom-Json
                    if (-not $fallbackSummary) {
                        $fallbackSummary = $parsed
                    }
                    if ($parsed.PSObject.Properties.Name -contains "health_status") {
                        $summary = $parsed
                        break
                    }
                } catch {
                    $parsed = $null
                }
            }
        }
    }
    if ($summary) {
        break
    }
}
if (-not $summary) {
    $summary = $fallbackSummary
}

$checks = [ordered]@{
    smoke_pass = $smokePass
    health_ok = [bool]($summary -and ($summary.health_status -eq 200))
    scoring_gate_checked = [bool]($summary -and (($summary.scoring_status -eq 200) -or ($summary.scoring_status -eq 400)))
    trend_checked = [bool]($summary -and ($summary.trend_count -ge 0))
    blocked_case_checked = [bool]($summary -and $summary.blocked_case)
    failed_rows_case_checked = [bool]($summary -and $summary.failed_rows_case)
}

$allChecksPass = $true
$failedChecks = @()
foreach ($entry in $checks.GetEnumerator()) {
    if (-not [bool]$entry.Value) {
        $allChecksPass = $false
        $failedChecks += [string]$entry.Key
    }
}

$acceptancePass = ($exitCode -eq 0) -and $allChecksPass

$report = [ordered]@{
    stage = "api_pull_to_quality_gate"
    generated_at = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    passed = $acceptancePass
    exit_code = $exitCode
    command = ".\\scripts\\run_quality_gate_smoke.ps1 -StartServer -BindHost $BindHost -Port $Port -Source $Source -ExerciseBlockedCase -ExerciseFailedRowsCase" + ($(if ($SkipRefresh) { " -SkipRefresh" } else { "" }))
    log_path = $logPath
    summary = $summary
    checks = $checks
    failed_checks = $failedChecks
}

$report | ConvertTo-Json -Depth 20 | Out-File -FilePath $reportPath -Encoding utf8

Write-Host "[INFO] Acceptance report: $reportPath"
Write-Host "[INFO] Acceptance log: $logPath"
if ($acceptancePass) {
    Write-Host "[PASS] quality gate acceptance"
} else {
    if ($failedChecks.Count -gt 0) {
        Write-Host ("[FAIL] failed checks: " + ($failedChecks -join ", "))
    }
    Write-Host "[FAIL] quality gate acceptance"
}

if ($acceptancePass) {
    exit 0
}
exit 1
