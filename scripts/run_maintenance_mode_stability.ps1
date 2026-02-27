param(
    [string]$BaseUrl = "",
    [int]$Runs = 3,
    [int]$IntervalSec = 15,
    [string]$OutputDir = "reports",
    [bool]$RefreshBeforeCheck = $true
)

$ErrorActionPreference = "Continue"

function Resolve-OutputDir {
    param([string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { $Dir = "reports" }
    if ([System.IO.Path]::IsPathRooted($Dir)) {
        return $Dir
    }
    $projectRoot = Split-Path -Parent $PSScriptRoot
    return Join-Path $projectRoot $Dir
}

if ($Runs -lt 1) {
    throw "Runs must be >= 1"
}
if ($IntervalSec -lt 0) {
    throw "IntervalSec must be >= 0"
}

$OutputDir = Resolve-OutputDir -Dir $OutputDir

if (-not (Test-Path -Path $OutputDir)) {
    New-Item -Path $OutputDir -ItemType Directory | Out-Null
}

$acceptScript = Join-Path $PSScriptRoot "run_maintenance_mode_acceptance.ps1"
if (-not (Test-Path -Path $acceptScript)) {
    throw "Acceptance script not found: $acceptScript"
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

$BaseUrl = Resolve-BaseUrl -InputBaseUrl $BaseUrl

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$summaryLog = Join-Path $OutputDir ("maintenance_mode_stability_{0}.log" -f $stamp)
$summaryFile = Join-Path $OutputDir ("maintenance_mode_stability_{0}.json" -f $stamp)
$alertFile = Join-Path $OutputDir ("maintenance_mode_alerts_{0}.jsonl" -f $stamp)

# Create alert file early so downstream tools always have a path to inspect.
New-Item -Path $alertFile -ItemType File -Force | Out-Null

$items = @()
$alertCount = 0

for ($i = 1; $i -le $Runs; $i++) {
    $startAt = Get-Date
    $ok = $true
    $message = ""
    $reportPath = ""
    $failedChecks = @()
    $failedCheckDetails = @()

    Write-Host ("[INFO] maintenance stability run {0}/{1}..." -f $i, $Runs)

    try {
        $refreshArg = if ($RefreshBeforeCheck) { "-RefreshBeforeCheck:`$true" } else { "-RefreshBeforeCheck:`$false" }
        $output = & powershell -ExecutionPolicy Bypass -File $acceptScript -BaseUrl $BaseUrl -OutputDir $OutputDir $refreshArg 2>&1
        $exitCode = $LASTEXITCODE
        $output | Tee-Object -FilePath $summaryLog -Append | Out-Null
        if ($exitCode -ne 0) {
            $ok = $false
            $message = "acceptance exit code $exitCode"
        }
    }
    catch {
        $ok = $false
        $message = $_.Exception.Message
    }

    $reports = Get-ChildItem -Path $OutputDir -Filter "maintenance_mode_acceptance_*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    $latestReport = $reports | Where-Object { $_.LastWriteTime -ge $startAt } | Select-Object -First 1
    if (-not $latestReport) {
        $latestReport = $reports | Select-Object -First 1
    }

    if ($latestReport) {
        $reportPath = $latestReport.FullName
        try {
            $reportObj = Get-Content -Path $latestReport.FullName -Encoding utf8 | ConvertFrom-Json
            if ($reportObj -and $reportObj.checks) {
                $failedItems = @($reportObj.checks | Where-Object { -not $_.passed })
                $failedChecks = @($failedItems | ForEach-Object { [string]$_.name })
                $failedCheckDetails = @($failedItems | ForEach-Object { [string]$_.detail })
                if ($failedChecks.Count -gt 0) {
                    $ok = $false
                    if ([string]::IsNullOrWhiteSpace($message)) {
                        $message = "failed checks: " + ($failedChecks -join ",")
                    }
                }
            }
        }
        catch {
            $ok = $false
            if ([string]::IsNullOrWhiteSpace($message)) {
                $message = "report_parse_error: " + $_.Exception.Message
            }
        }
    }
    elseif ($ok) {
        $ok = $false
        $message = "acceptance_report_not_found"
    }

    if (-not $ok) {
        $alertCount += 1
        $alertRecord = [ordered]@{
            timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
            run = $i
            base_url = $BaseUrl
            report = $reportPath
            failed_checks = $failedChecks
            failed_check_details = $failedCheckDetails
            message = $message
        }
        ($alertRecord | ConvertTo-Json -Depth 8 -Compress) | Add-Content -Path $alertFile -Encoding utf8
    }

    $items += [PSCustomObject]@{
        run = $i
        started_at = $startAt.ToString("yyyy-MM-dd HH:mm:ss")
        passed = $ok
        message = $message
        report = $reportPath
        failed_checks = $failedChecks
    }

    if ($i -lt $Runs -and $IntervalSec -gt 0) {
        Start-Sleep -Seconds $IntervalSec
    }
}

$passedCount = @($items | Where-Object { $_.passed }).Count
$allPassed = ($passedCount -eq $Runs)
$now = Get-Date

$summary = [ordered]@{
    stage = "maintenance_mode"
    timestamp = $now.ToString("yyyy-MM-dd HH:mm:ss")
    base_url = $BaseUrl
    runs = $Runs
    interval_sec = $IntervalSec
    refresh_before_check = $RefreshBeforeCheck
    passed = $allPassed
    passed_count = $passedCount
    failed_count = $Runs - $passedCount
    alert_count = $alertCount
    alert_log = $alertFile
    stability_log = $summaryLog
    results = $items
}

$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $summaryFile -Encoding utf8

Write-Host "Maintenance mode stability summary:"
Write-Host "  passed: $allPassed ($passedCount/$Runs)"
Write-Host "  summary: $summaryFile"
Write-Host "  alerts: $alertFile (count=$alertCount)"
Write-Host "  log: $summaryLog"

if (-not $allPassed) {
    exit 1
}
