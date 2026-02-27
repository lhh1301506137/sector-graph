param(
    [string]$BaseUrl = "",
    [int]$Runs = 3,
    [int]$IntervalSec = 15,
    [int]$Days = 20,
    [string]$OutputDir = "reports"
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

$OutputDir = Resolve-OutputDir -Dir $OutputDir
$BaseUrl = Resolve-BaseUrl -InputBaseUrl $BaseUrl

if (-not (Test-Path -Path $OutputDir)) {
    New-Item -Path $OutputDir -ItemType Directory | Out-Null
}

$acceptScript = Join-Path $PSScriptRoot "run_backtest_stage_acceptance.ps1"
if (-not (Test-Path -Path $acceptScript)) {
    throw "Acceptance script not found: $acceptScript"
}

$items = @()

for ($i = 1; $i -le $Runs; $i++) {
    $startAt = Get-Date
    $ok = $true
    $message = ""

    try {
        & powershell -ExecutionPolicy Bypass -File $acceptScript -BaseUrl $BaseUrl -Days $Days -OutputDir $OutputDir
        if ($LASTEXITCODE -ne 0) {
            $ok = $false
            $message = "acceptance exit code $LASTEXITCODE"
        }
    } catch {
        $ok = $false
        $message = $_.Exception.Message
    }

    $latestReport = Get-ChildItem -Path $OutputDir -Filter "backtest_stage_acceptance_*.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    $items += [PSCustomObject]@{
        run = $i
        started_at = $startAt.ToString("yyyy-MM-dd HH:mm:ss")
        passed = $ok
        message = $message
        report = if ($latestReport) { $latestReport.FullName } else { "" }
    }

    if ($i -lt $Runs) {
        Start-Sleep -Seconds $IntervalSec
    }
}

$passedCount = @($items | Where-Object { $_.passed }).Count
$allPassed = ($passedCount -eq $Runs)
$now = Get-Date

$summary = [ordered]@{
    timestamp = $now.ToString("yyyy-MM-dd HH:mm:ss")
    base_url = $BaseUrl
    runs = $Runs
    interval_sec = $IntervalSec
    days = $Days
    passed = $allPassed
    passed_count = $passedCount
    failed_count = $Runs - $passedCount
    results = $items
}

$summaryFile = Join-Path $OutputDir ("backtest_stage_stability_{0}.json" -f $now.ToString("yyyyMMdd_HHmmss"))
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryFile -Encoding UTF8

Write-Host "Backtest stage stability summary:"
Write-Host "  passed: $allPassed ($passedCount/$Runs)"
Write-Host "  summary: $summaryFile"

if (-not $allPassed) {
    exit 1
}
