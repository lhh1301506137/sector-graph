param(
    [string]$BaseUrl = "",
    [string]$OutputDir = "reports",
    [bool]$RefreshBeforeCheck = $true
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
    $hasReleaseStage = $html.Contains("release-check-panel")
    $hasRunbookPanel = $html.Contains("release-runbook-panel")
    Add-Check "release_stage_visible" $hasReleaseStage "stage_text_visible=$hasReleaseStage"
    Add-Check "release_runbook_visible" $hasRunbookPanel "runbook_panel_visible=$hasRunbookPanel"

    $sync = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/sync-status"
    $lastSyncAt = [string]($sync.last_sync_at)
    $compareStatus = [string]($sync.compare.status)
    $syncOk = (-not [string]::IsNullOrWhiteSpace($lastSyncAt)) -and ($compareStatus -ne "error")
    Add-Check "ops_health_baseline" $syncOk "last_sync_at=$lastSyncAt, compare_status=$compareStatus"

    $quality = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/data-quality/latest"
    $publishAllowed = [bool]$quality.publish_allowed
    Add-Check "quality_gate_publishable" $publishAllowed "publish_allowed=$publishAllowed, total_rows=$($quality.total_rows), failed_rows=$($quality.failed_rows)"

    $jobsResp = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/backtest/jobs?limit=5"
    $jobs = Normalize-List -Value $jobsResp
    $latestJob = if ($jobs.Count -gt 0) { $jobs[0] } else { $null }
    $latestRunId = if ($latestJob) { [string]$latestJob.run_id } else { "" }
    $latestStatus = if ($latestJob) { [string]$latestJob.status } else { "" }
    $backtestOk = ($latestJob -ne $null) -and ($latestStatus -eq "completed")
    Add-Check "latest_backtest_completed" $backtestOk "latest_run_id=$latestRunId, latest_status=$latestStatus"

    $versionStatus = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/config/versioning/status"
    $latestVersion = $versionStatus.latest_applied_version
    $versionId = if ($latestVersion) { [string]$latestVersion.id } else { "" }
    $versionState = if ($latestVersion) { [string]$latestVersion.status } else { "" }
    $versionOk = ($latestVersion -ne $null) -and ($versionState -eq "refeeded")
    Add-Check "latest_version_refeeded" $versionOk "version_id=$versionId, version_status=$versionState"

    $snapshot = [ordered]@{
        sync = [ordered]@{
            last_sync_at = $lastSyncAt
            compare_status = $compareStatus
        }
        quality = [ordered]@{
            publish_allowed = $publishAllowed
            total_rows = [int]$quality.total_rows
            failed_rows = [int]$quality.failed_rows
        }
        backtest = [ordered]@{
            latest_run_id = $latestRunId
            latest_status = $latestStatus
        }
        version = [ordered]@{
            latest_applied_id = $versionId
            latest_applied_status = $versionState
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

$file = Join-Path $OutputDir ("release_stage_acceptance_{0}.json" -f $now.ToString("yyyyMMdd_HHmmss"))
$report | ConvertTo-Json -Depth 8 | Set-Content -Path $file -Encoding UTF8

Write-Host "Release stage acceptance report:"
Write-Host "  passed: $allPassed"
Write-Host "  report: $file"

if (-not $allPassed) {
    exit 1
}
