param(
    [string]$BaseUrl = "",
    [string]$OutputDir = "reports",
    [bool]$RefreshBeforeCheck = $true,
    [int]$BacktestLimit = 5
)

$ErrorActionPreference = "Stop"

function Add-Check {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Detail
    )
    $script:checks += [PSCustomObject]@{
        name   = $Name
        passed = $Passed
        detail = $Detail
    }
}

function Safe-Invoke {
    param(
        [string]$Method,
        [string]$Url
    )
    if ($Method -eq "GET") {
        return Invoke-RestMethod -Method Get $Url
    }
    return Invoke-RestMethod -Method $Method $Url
}

function Normalize-List {
    param($Value)
    if ($null -eq $Value) { return @() }
    if ($Value -is [System.Array]) { return $Value }
    if ($Value.PSObject -and ($Value.PSObject.Properties.Name -contains "value")) {
        $inner = $Value.value
        if ($null -eq $inner) { return @() }
        if ($inner -is [System.Array]) { return $inner }
        return @($inner)
    }
    if ($Value.PSObject -and ($Value.PSObject.Properties.Name -contains "items")) {
        $items = $Value.items
        if ($null -eq $items) { return @() }
        if ($items -is [System.Array]) { return $items }
        return @($items)
    }
    return @($Value)
}

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

$OutputDir = Resolve-OutputDir -Dir $OutputDir
$BaseUrl = Resolve-BaseUrl -InputBaseUrl $BaseUrl

$checks = @()
$snapshot = [ordered]@{}

try {
    if ($RefreshBeforeCheck) {
        $refreshResp = Safe-Invoke -Method "POST" -Url "$BaseUrl/api/sectors/refresh"
        $refreshOk = $null -ne $refreshResp
        Add-Check "pre_refresh" $refreshOk "refresh_api_called=$refreshOk"
    } else {
        Add-Check "pre_refresh" $true "skip: RefreshBeforeCheck=false"
    }

    $homeResp = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/" -TimeoutSec 12
    $html = [string]$homeResp.Content
    $hasOpsPanel = $html.Contains("ops-monitor-panel")
    $hasStage8 = $html.Contains("pipeline-stage-panel")
    $hasOpsDetail = $html.Contains("ops-monitor-detail")
    Add-Check "home_ops_panel_visible" ($hasOpsPanel -and $hasOpsDetail) "ops_panel=$hasOpsPanel, detail_container=$hasOpsDetail"
    Add-Check "home_stage8_visible" $hasStage8 "stage8_text=$hasStage8"

    $sync = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/sync-status"
    $hasSyncAt = $sync.PSObject.Properties.Name -contains "last_sync_at"
    $hasCompare = $sync.PSObject.Properties.Name -contains "compare"
    $compareStatus = [string]($sync.compare.status)
    Add-Check "signal_sync_payload" ($hasSyncAt -and $hasCompare) "last_sync_at=$($sync.last_sync_at), compare_status=$compareStatus"

    $quality = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/data-quality/latest"
    $hasPublishAllowed = $quality.PSObject.Properties.Name -contains "publish_allowed"
    $hasTotalRows = $quality.PSObject.Properties.Name -contains "total_rows"
    Add-Check "signal_quality_payload" ($hasPublishAllowed -and $hasTotalRows) "publish_allowed=$($quality.publish_allowed), total_rows=$($quality.total_rows), failed_rows=$($quality.failed_rows)"

    $qualityTrend = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/data-quality/trend?days=7"
    $trendItems = Normalize-List -Value $qualityTrend.items
    Add-Check "signal_quality_trend_payload" ($trendItems.Count -ge 1) "trend_rows=$($trendItems.Count)"

    $jobsResp = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/backtest/jobs?limit=$BacktestLimit"
    $jobs = Normalize-List -Value $jobsResp
    $firstRunId = if ($jobs.Count -gt 0) { [string]$jobs[0].run_id } else { "" }
    $firstStatus = if ($jobs.Count -gt 0) { [string]$jobs[0].status } else { "" }
    $jobsPayloadOk = $jobs.Count -eq 0 -or (($jobs[0].PSObject.Properties.Name -contains "run_id") -and ($jobs[0].PSObject.Properties.Name -contains "status"))
    Add-Check "signal_backtest_payload" $jobsPayloadOk "job_count=$($jobs.Count), first_run_id=$firstRunId, first_status=$firstStatus"

    $versionStatus = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/config/versioning/status"
    $hasLatestApplied = $versionStatus.PSObject.Properties.Name -contains "latest_applied_version"
    $latestVersion = $versionStatus.latest_applied_version
    $versionId = if ($latestVersion) { [string]$latestVersion.id } else { "" }
    $versionState = if ($latestVersion) { [string]$latestVersion.status } else { "" }
    Add-Check "signal_version_payload" $hasLatestApplied "has_latest_applied_version=$hasLatestApplied, version_id=$versionId, version_status=$versionState"

    $compareLevel = if ($compareStatus -eq "error") { "error" } elseif ($compareStatus -eq "ok") { "ok" } elseif ([string]::IsNullOrWhiteSpace($compareStatus)) { "pending" } else { "warn" }
    $qualityLevel = if (-not $hasPublishAllowed) { "pending" } elseif ($quality.publish_allowed) { "ok" } else { "error" }
    $backtestLevel = if ($jobs.Count -eq 0) { "pending" } elseif (($firstStatus -eq "failed") -or ($firstStatus -eq "cancelled")) { "warn" } else { "ok" }
    $versionLevel = if (-not $latestVersion) { "pending" } elseif (($versionState -eq "refeeded") -or ($versionState -eq "applied")) { "ok" } else { "warn" }

    $levels = @("ok", $qualityLevel, $compareLevel, $backtestLevel, $versionLevel)
    $errorCount = ($levels | Where-Object { $_ -eq "error" }).Count
    $warnCount = ($levels | Where-Object { $_ -eq "warn" }).Count
    $pendingCount = ($levels | Where-Object { $_ -eq "pending" }).Count
    Add-Check "ops_signal_coverage" $true "signals=5, error=$errorCount, warn=$warnCount, pending=$pendingCount"

    $snapshot = [ordered]@{
        sync = [ordered]@{
            last_sync_at = [string]$sync.last_sync_at
            source_name = [string]$sync.source_name
            compare_status = $compareStatus
        }
        quality = [ordered]@{
            publish_allowed = [bool]$quality.publish_allowed
            total_rows = [int]$quality.total_rows
            failed_rows = [int]$quality.failed_rows
        }
        compare = [ordered]@{
            status = $compareStatus
            matched_count = [int]$sync.compare.matched_count
            warn_count = [int]$sync.compare.warn_count
        }
        backtest = [ordered]@{
            job_count = $jobs.Count
            latest_run_id = $firstRunId
            latest_status = $firstStatus
        }
        version = [ordered]@{
            latest_applied_id = $versionId
            latest_applied_status = $versionState
        }
        monitor_health = [ordered]@{
            error_count = $errorCount
            warn_count = $warnCount
            pending_count = $pendingCount
        }
    }
}
catch {
    Add-Check "script_runtime" $false $_.Exception.Message
}

$allPassed = ($checks | Where-Object { -not $_.passed }).Count -eq 0
$now = Get-Date

if (-not (Test-Path -Path $OutputDir)) {
    New-Item -Path $OutputDir -ItemType Directory | Out-Null
}

$report = [ordered]@{
    timestamp = $now.ToString("yyyy-MM-dd HH:mm:ss")
    base_url = $BaseUrl
    refresh_before_check = $RefreshBeforeCheck
    passed = $allPassed
    checks = $checks
    snapshot = $snapshot
}

$file = Join-Path $OutputDir ("ops_observability_acceptance_{0}.json" -f $now.ToString("yyyyMMdd_HHmmss"))
$report | ConvertTo-Json -Depth 8 | Set-Content -Path $file -Encoding UTF8

Write-Host "Ops observability acceptance report:"
Write-Host "  passed: $allPassed"
Write-Host "  report: $file"

if (-not $allPassed) {
    exit 1
}
