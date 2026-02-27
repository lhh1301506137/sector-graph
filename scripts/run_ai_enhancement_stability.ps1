param(
    [string]$BaseUrl = "",
    [int]$Runs = 10,
    [int]$IntervalSec = 3,
    [int]$BacktestDays = 20,
    [bool]$RunBacktest = $true,
    [bool]$PreRefresh = $true,
    [string]$OutputDir = "reports"
)

$ErrorActionPreference = "Stop"

function Resolve-OutputDir {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { $Dir = "reports" }
    if ([System.IO.Path]::IsPathRooted($Dir)) {
        return $Dir
    }
    $projectRoot = Split-Path -Parent $PSScriptRoot
    return Join-Path $projectRoot $Dir
}

function Resolve-BaseUrl {
    param([string]$InputBaseUrl)

    if (-not [string]::IsNullOrWhiteSpace($InputBaseUrl)) {
        return $InputBaseUrl.Trim().TrimEnd("/")
    }

    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:SG_BASE_URL)) {
        $candidates += [string]$env:SG_BASE_URL
    }

    $appHost = if ([string]::IsNullOrWhiteSpace($env:APP_HOST)) { "127.0.0.1" } else { [string]$env:APP_HOST }
    if (-not [string]::IsNullOrWhiteSpace($env:APP_PORT)) {
        $candidates += ("http://{0}:{1}" -f $appHost, $env:APP_PORT)
    }

    $candidates += @(
        "http://127.0.0.1:18008",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:18080",
        "http://127.0.0.1:18081"
    )

    $seen = @{}
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $base = ([string]$candidate).Trim().TrimEnd("/")
        if ($seen.ContainsKey($base)) { continue }
        $seen[$base] = $true
        try {
            $sync = Invoke-RestMethod -Method Get -Uri "$base/api/sync-status" -TimeoutSec 5
            if ($null -ne $sync -and [string]$sync.status -eq "ok") {
                return $base
            }
        }
        catch {
            continue
        }
    }

    throw "No available sector-graph service found. Start service first or pass -BaseUrl explicitly."
}

if ($Runs -lt 1) {
    throw "Runs must be >= 1"
}
if ($IntervalSec -lt 0) {
    throw "IntervalSec must be >= 0"
}

$OutputDir = Resolve-OutputDir -Dir $OutputDir
$BaseUrl = Resolve-BaseUrl -InputBaseUrl $BaseUrl

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$acceptScript = Join-Path $PSScriptRoot "run_ai_enhancement_acceptance.ps1"
if (-not (Test-Path $acceptScript)) {
    throw "Acceptance script not found: $acceptScript"
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$summaryPath = Join-Path $OutputDir ("ai_enhancement_stability_{0}.json" -f $stamp)
$summaryLogPath = Join-Path $OutputDir ("ai_enhancement_stability_{0}.log" -f $stamp)

$items = @()
$allPassed = $true
$refreshInfo = @{
    enabled = $PreRefresh
    success = $false
    message = ""
}

if ($PreRefresh) {
    Write-Host "[INFO] Pre-refresh sectors before stability runs..."
    try {
        $refresh = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/sectors/refresh"
        $refreshInfo.success = $true
        $refreshInfo.message = "updated=$($refresh.updated), last_sync_at=$($refresh.last_sync_at)"
        $refresh | Tee-Object -FilePath $summaryLogPath -Append | Out-Null
    }
    catch {
        $refreshInfo.success = $false
        $refreshInfo.message = $_.Exception.Message
        $_ | Tee-Object -FilePath $summaryLogPath -Append | Out-Null
        throw "Pre-refresh failed: $($refreshInfo.message)"
    }
}

for ($i = 1; $i -le $Runs; $i++) {
    Write-Host ("[INFO] AI enhancement stability run {0}/{1}" -f $i, $Runs)
    $startAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    $runPassed = $false
    $exitCode = 0
    $msg = ""

    try {
        if ($RunBacktest) {
            $output = & $acceptScript -BaseUrl $BaseUrl -BacktestDays $BacktestDays -RunBacktest -OutputDir $OutputDir 2>&1
        }
        else {
            $output = & $acceptScript -BaseUrl $BaseUrl -BacktestDays $BacktestDays -OutputDir $OutputDir 2>&1
        }
        $exitCode = 0
        $output | Tee-Object -FilePath $summaryLogPath -Append | Out-Null
        $runPassed = $true
    }
    catch {
        $exitCode = 1
        $msg = $_.Exception.Message
        $_ | Tee-Object -FilePath $summaryLogPath -Append | Out-Null
        $runPassed = $false
    }

    $latestReport = Get-ChildItem -Path $OutputDir -Filter "ai_enhancement_acceptance_*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    $reportPath = ""
    $applyStatus = ""
    $versionStatus = ""
    $scoringStatus = ""
    $backtestStatus = ""

    if ($latestReport) {
        $reportPath = $latestReport.FullName
        try {
            $reportJson = Get-Content -Path $latestReport.FullName -Raw | ConvertFrom-Json
            $applyStatus = [string]$reportJson.apply_status
            $versionStatus = [string]$reportJson.version_status
            $scoringStatus = [string]$reportJson.scoring_status
            $backtestStatus = [string]$reportJson.backtest_status

            if ($applyStatus -ne "ok" -or $scoringStatus -ne "ok") {
                $runPassed = $false
            }
            if ($versionStatus -ne "refeeded") {
                $runPassed = $false
            }
            if ($RunBacktest -and $backtestStatus -ne "completed") {
                $runPassed = $false
            }
        }
        catch {
            $runPassed = $false
            if (-not $msg) {
                $msg = "failed_to_parse_report_json"
            }
        }
    }
    else {
        $runPassed = $false
        if (-not $msg) {
            $msg = "acceptance_report_not_found"
        }
    }

    if (-not $runPassed) {
        $allPassed = $false
    }

    $items += [ordered]@{
        run_no = $i
        started_at = $startAt
        exit_code = $exitCode
        passed = $runPassed
        message = $msg
        report_path = $reportPath
        apply_status = $applyStatus
        version_status = $versionStatus
        scoring_status = $scoringStatus
        backtest_status = $backtestStatus
    }

    if ($i -lt $Runs -and $IntervalSec -gt 0) {
        Start-Sleep -Seconds $IntervalSec
    }
}

$passCount = @($items | Where-Object { $_.passed }).Count
$summary = [ordered]@{
    stage = "ai_enhancement_refeed_loop"
    generated_at = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
    base_url = $BaseUrl
    runs = $Runs
    interval_sec = $IntervalSec
    backtest_days = $BacktestDays
    run_backtest = $RunBacktest
    pre_refresh = $refreshInfo
    all_passed = $allPassed
    passed_count = $passCount
    failed_count = $Runs - $passCount
    items = $items
    log_path = $summaryLogPath
}

$summary | ConvertTo-Json -Depth 20 | Set-Content -Path $summaryPath -Encoding UTF8
Write-Host "[INFO] Stability summary: $summaryPath"
Write-Host "[INFO] Stability log: $summaryLogPath"

if ($allPassed) {
    Write-Host "[PASS] ai enhancement stability"
    exit 0
}

Write-Host "[FAIL] ai enhancement stability"
exit 1