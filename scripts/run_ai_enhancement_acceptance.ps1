param(
    [string]$BaseUrl = "",
    [int]$BacktestDays = 20,
    [switch]$RunBacktest,
    [string]$OutputDir = "reports"
)

$ErrorActionPreference = "Stop"

function Invoke-ApiJson {
    param(
        [string]$Method,
        [string]$Url,
        [object]$Body = $null
    )

    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $Url
    }

    $json = $Body | ConvertTo-Json -Depth 10
    return Invoke-RestMethod -Method $Method -Uri $Url -ContentType "application/json" -Body $json
}

function Ensure-LatestVersionId {
    param([string]$ApiBase)

    $versions = Invoke-ApiJson -Method "GET" -Url "$ApiBase/api/config/versions?limit=1"
    if ($versions -and $versions.Count -gt 0) {
        return [int]$versions[0].id
    }

    $cfg = Invoke-ApiJson -Method "GET" -Url "$ApiBase/api/config"
    $snapshot = @{}
    if ($cfg -and $cfg.algo) {
        foreach ($p in $cfg.algo.PSObject.Properties) {
            if ($p.Name -like "*_masked" -or $p.Name -like "*_set") { continue }
            $snapshot[$p.Name] = [string]$p.Value
        }
    }

    $saveBody = @{
        snapshot = $snapshot
        source_type = "manual"
        reason = "ai_enhancement_acceptance_seed"
        apply_now = $true
    }
    $save = Invoke-ApiJson -Method "POST" -Url "$ApiBase/api/config/versions/save" -Body $saveBody
    return [int]$save.version.id
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

$health = Invoke-ApiJson -Method "GET" -Url "$BaseUrl/api/health"
if (-not $health -or $health.status -ne "ok") {
    throw "health check failed"
}

$versionId = Ensure-LatestVersionId -ApiBase $BaseUrl
$applyBody = @{
    reason = "ai_enhancement_acceptance_apply_refeed"
    run_scoring = $true
    run_backtest = [bool]$RunBacktest
    backtest_days = [int]$BacktestDays
}
$apply = Invoke-ApiJson -Method "POST" -Url "$BaseUrl/api/config/versions/$versionId/apply" -Body $applyBody
$status = Invoke-ApiJson -Method "GET" -Url "$BaseUrl/api/config/versioning/status"

$backtestRunId = ""
$backtestStatus = ""
if ($apply.backtest -and $apply.backtest.run_id) {
    $backtestRunId = [string]$apply.backtest.run_id
    Start-Sleep -Seconds 1
    $job = Invoke-ApiJson -Method "GET" -Url "$BaseUrl/api/backtest/jobs/$backtestRunId"
    if ($job) { $backtestStatus = [string]$job.status }
}

$report = [ordered]@{
    checked_at = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    base_url = $BaseUrl
    version_id = $versionId
    apply_status = [string]$apply.status
    version_status = [string]$apply.version.status
    scoring_status = [string]$apply.scoring.status
    scoring_run_id = [string]$apply.scoring.run_id
    backtest_run_id = $backtestRunId
    backtest_status = $backtestStatus
    latest_applied_id = [int]$status.latest_applied_version.id
    latest_applied_status = [string]$status.latest_applied_version.status
}

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$reportPath = Join-Path $OutputDir "ai_enhancement_acceptance_$ts.json"
$report | ConvertTo-Json -Depth 8 | Set-Content -Path $reportPath -Encoding UTF8

$report
Write-Host "report: $reportPath"