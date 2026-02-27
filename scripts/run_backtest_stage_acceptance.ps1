param(
    [string]$BaseUrl = "",
    [int]$Days = 30,
    [int]$PollIntervalSec = 2,
    [int]$MaxPoll = 90,
    [string]$OutputDir = "reports"
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

function Safe-Count {
    param($Value)
    $arr = Normalize-List -Value $Value
    return $arr.Count
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
$runId = ""
$finalStatus = "unknown"
$newRunId = ""

try {
    $runResp = Safe-Invoke -Method "POST" -Url "$BaseUrl/api/backtest/run?days=$Days"
    $runId = [string]$runResp.run_id
    $isProcessing = ([string]$runResp.status -eq "processing") -and (-not [string]::IsNullOrWhiteSpace($runId))
    Add-Check "run_trigger" $isProcessing "status=$($runResp.status), run_id=$runId"

    $job = $null
    if (-not [string]::IsNullOrWhiteSpace($runId)) {
        for ($i = 0; $i -lt $MaxPoll; $i++) {
            Start-Sleep -Seconds $PollIntervalSec
            $job = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/backtest/jobs/$runId"
            $status = [string]$job.status
            if ($status -in @("completed", "failed", "cancelled")) {
                break
            }
        }
        $finalStatus = [string]$job.status
    }
    Add-Check "job_terminal_state" ($finalStatus -in @("completed", "failed", "cancelled")) "final_status=$finalStatus"

    if (-not [string]::IsNullOrWhiteSpace($runId)) {
        $cancelResp = Safe-Invoke -Method "POST" -Url "$BaseUrl/api/backtest/jobs/$runId/cancel"
        $cancelOk = ([string]$cancelResp.status -in @("ok", "ignored"))
        Add-Check "cancel_semantics" $cancelOk "status=$($cancelResp.status), message=$($cancelResp.message)"
    } else {
        Add-Check "cancel_semantics" $false "missing run_id"
    }

    if ($finalStatus -in @("failed", "cancelled")) {
        $retryResp = Safe-Invoke -Method "POST" -Url "$BaseUrl/api/backtest/jobs/$runId/retry"
        $newRunId = [string]$retryResp.new_run_id
        $retryOk = ([string]$retryResp.status -eq "ok") -and (-not [string]::IsNullOrWhiteSpace($newRunId))
        Add-Check "retry_semantics" $retryOk "status=$($retryResp.status), new_run_id=$newRunId"
    } else {
        Add-Check "retry_semantics" $true "skip: final_status=$finalStatus (only failed/cancelled requires retry)"
    }

    if (-not [string]::IsNullOrWhiteSpace($runId)) {
        $resultResp = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/backtest/results?limit=10&run_id=$runId"
        $resultRows = Normalize-List -Value $resultResp
        $resultCount = $resultRows.Count
        Add-Check "result_list_available" ($resultCount -ge 0) "count=$resultCount, run_id=$runId"

        if ($resultCount -gt 0) {
            $firstDate = [string]$resultRows[0].date
            $dayResp = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/backtest/results/$($firstDate)?run_id=$runId"
            $dayOk = ([string]$dayResp.date -eq $firstDate) -and ([string]$dayResp.run_id -eq $runId)
            Add-Check "result_day_match" $dayOk "date=$($dayResp.date), run_id=$($dayResp.run_id), expected=$runId"

            $sampleRows = @($resultRows | Select-Object -First 3)
            $mismatchCount = 0
            $mismatchDetail = ""
            foreach ($row in $sampleRows) {
                $date = [string]$row.date
                if ([string]::IsNullOrWhiteSpace($date)) { continue }
                $detail = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/backtest/results/$($date)?run_id=$runId"
                $trendHits = [int]($row.hits)
                $trendAlpha = [double]($row.alpha)
                $detailHits = [int]($detail.hits)
                $detailAlpha = [double]($detail.alpha)
                $sameHits = ($trendHits -eq $detailHits)
                $sameAlpha = ([Math]::Abs($trendAlpha - $detailAlpha) -lt 0.0001)
                if (-not ($sameHits -and $sameAlpha)) {
                    $mismatchCount += 1
                    if (-not $mismatchDetail) {
                        $mismatchDetail = "date=$date trend_hits=$trendHits detail_hits=$detailHits trend_alpha=$trendAlpha detail_alpha=$detailAlpha"
                    }
                }
            }
            $consistencyOk = ($mismatchCount -eq 0)
            $consistencyDetail = if ($consistencyOk) {
                "sample_count=$($sampleRows.Count), mismatches=0"
            } else {
                "sample_count=$($sampleRows.Count), mismatches=$mismatchCount, first=$mismatchDetail"
            }
            Add-Check "trend_day_consistency" $consistencyOk $consistencyDetail
        } else {
            Add-Check "result_day_match" $true "skip: this run has no daily result rows"
            Add-Check "trend_day_consistency" $true "skip: this run has no daily result rows"
        }
    } else {
        Add-Check "result_list_available" $false "missing run_id"
        Add-Check "result_day_match" $false "missing run_id"
        Add-Check "trend_day_consistency" $false "missing run_id"
    }

    $prod = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/ranking?run_type=prod&limit=5"
    $backtest = Safe-Invoke -Method "GET" -Url "$BaseUrl/api/ranking?run_type=backtest&limit=5"
    $prodJson = ($prod | ConvertTo-Json -Depth 8 -Compress)
    $backtestJson = ($backtest | ConvertTo-Json -Depth 8 -Compress)
    $prodCount = Safe-Count $prod
    $backtestCount = Safe-Count $backtest
    $isolationOk = ($prodJson -ne $backtestJson)
    Add-Check "run_type_isolation" $isolationOk "prod_count=$prodCount, backtest_count=$backtestCount"
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
    days = $Days
    run_id = $runId
    final_status = $finalStatus
    retry_new_run_id = $newRunId
    passed = $allPassed
    checks = $checks
}

$file = Join-Path $OutputDir ("backtest_stage_acceptance_{0}.json" -f $now.ToString("yyyyMMdd_HHmmss"))
$report | ConvertTo-Json -Depth 8 | Set-Content -Path $file -Encoding UTF8

Write-Host "Backtest stage acceptance report:"
Write-Host "  passed: $allPassed"
Write-Host "  run_id: $runId"
Write-Host "  final_status: $finalStatus"
Write-Host "  report: $file"

if (-not $allPassed) {
    exit 1
}
