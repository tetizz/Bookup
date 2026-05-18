param(
    [string]$SettingsFile = ".\regression_runs\settings.json",
    [string]$Dataset = "",
    [string]$OutputDir = "",
    [int]$Limit = -1,
    [int]$Offset = -1,
    [int]$Stride = -1,
    [double]$Time = -1,
    [int]$Depth = -1,
    [int]$MultiPV = -1,
    [string]$Engine = "",
    [int]$Threads = -1,
    [int]$HashMB = -1,
    [int]$Workers = -1,
    [int]$StatusEvery = -1,
    [int]$CheckpointEvery = -1,
    [int]$DashboardPort = -1,
    [switch]$OpenDashboard,
    [switch]$Resume,
    [switch]$InitOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Resolve-RepoPath {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return ""
    }
    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return $PathValue
    }
    return Join-Path $repoRoot $PathValue
}

function Get-JsonObject {
    param([string]$PathValue)
    if (-not (Test-Path -LiteralPath $PathValue)) {
        return @{}
    }
    $raw = Get-Content -LiteralPath $PathValue -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @{}
    }
    return ($raw | ConvertFrom-Json -AsHashtable)
}

function Set-JsonObject {
    param(
        [string]$PathValue,
        [hashtable]$Data
    )
    $parent = Split-Path -Parent $PathValue
    if ($parent) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $json = $Data | ConvertTo-Json -Depth 6
    Set-Content -LiteralPath $PathValue -Value $json -Encoding UTF8
}

function Get-IntValue {
    param($Value, [int]$Fallback)
    if ($null -eq $Value -or $Value -eq "") {
        return $Fallback
    }
    return [int]$Value
}

function Get-DoubleValue {
    param($Value, [double]$Fallback)
    if ($null -eq $Value -or $Value -eq "") {
        return $Fallback
    }
    return [double]$Value
}

$settingsPath = Resolve-RepoPath $SettingsFile
$configPath = Join-Path $repoRoot "config.json"
$config = Get-JsonObject $configPath
$savedSettings = Get-JsonObject $settingsPath

$defaultSettings = [ordered]@{
    dataset         = ".\brilliants_no_stalemates.csv"
    outputDir       = ".\regression_runs\latest"
    limit           = 0
    offset          = 0
    stride          = 1
    time            = Get-DoubleValue $config["think_time_sec"] 5.0
    depth           = Get-IntValue $config["depth"] 26
    multipv         = Get-IntValue $config["multipv"] 5
    engine          = [string]($config["engine_path"] ?? "")
    threads         = Get-IntValue $config["threads"] 16
    hashMB          = Get-IntValue $config["hash_mb"] 512
    workers         = [Math]::Max(1, (Get-IntValue $config["parallel_workers"] 8))
    statusEvery     = 25
    checkpointEvery = 100
    dashboardPort   = 8765
    openDashboard   = $true
    resume          = $false
}

$effective = [ordered]@{}
foreach ($key in $defaultSettings.Keys) {
    if ($savedSettings.ContainsKey($key) -and $null -ne $savedSettings[$key] -and $savedSettings[$key] -ne "") {
        $effective[$key] = $savedSettings[$key]
    }
    else {
        $effective[$key] = $defaultSettings[$key]
    }
}

if ($Dataset) { $effective["dataset"] = $Dataset }
if ($OutputDir) { $effective["outputDir"] = $OutputDir }
if ($Limit -ge 0) { $effective["limit"] = $Limit }
if ($Offset -ge 0) { $effective["offset"] = $Offset }
if ($Stride -gt 0) { $effective["stride"] = $Stride }
if ($Time -gt 0) { $effective["time"] = $Time }
if ($Depth -gt 0) { $effective["depth"] = $Depth }
if ($MultiPV -gt 0) { $effective["multipv"] = $MultiPV }
if ($Engine) { $effective["engine"] = $Engine }
if ($Threads -gt 0) { $effective["threads"] = $Threads }
if ($HashMB -gt 0) { $effective["hashMB"] = $HashMB }
if ($Workers -gt 0) { $effective["workers"] = $Workers }
if ($StatusEvery -gt 0) { $effective["statusEvery"] = $StatusEvery }
if ($CheckpointEvery -gt 0) { $effective["checkpointEvery"] = $CheckpointEvery }
if ($DashboardPort -ge 0) { $effective["dashboardPort"] = $DashboardPort }
if ($OpenDashboard.IsPresent) { $effective["openDashboard"] = $true }
if ($Resume.IsPresent) { $effective["resume"] = $true }

$effective["time"] = [double]$effective["time"]
$effective["depth"] = [int]$effective["depth"]
$effective["multipv"] = [int]$effective["multipv"]
$effective["threads"] = [int]$effective["threads"]
$effective["hashMB"] = [int]$effective["hashMB"]
$effective["workers"] = [int]$effective["workers"]
$effective["limit"] = [int]$effective["limit"]
$effective["offset"] = [int]$effective["offset"]
$effective["stride"] = [int]$effective["stride"]
$effective["statusEvery"] = [int]$effective["statusEvery"]
$effective["checkpointEvery"] = [int]$effective["checkpointEvery"]
$effective["dashboardPort"] = [int]$effective["dashboardPort"]
$effective["openDashboard"] = [bool]$effective["openDashboard"]
$effective["resume"] = [bool]$effective["resume"]

Set-JsonObject -PathValue $settingsPath -Data $effective

if ($InitOnly) {
    Write-Host ""
    Write-Host "Initialized Bookup brilliant regression settings." -ForegroundColor Green
    Write-Host "Settings: $settingsPath"
    exit 0
}

$resolvedOutputDir = Resolve-RepoPath $effective["outputDir"]
if (-not (Test-Path -LiteralPath $resolvedOutputDir)) {
    New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null
}

$stateFile = Join-Path $resolvedOutputDir "state.json"
$resultsCsv = Join-Path $resolvedOutputDir "results.csv"
$missesCsv = Join-Path $resolvedOutputDir "misses.csv"
$summaryJson = Join-Path $resolvedOutputDir "summary.json"
$resolvedDataset = Resolve-RepoPath $effective["dataset"]

$command = @(
    "python",
    "scripts\brilliant_dataset_regression.py",
    "--csv", $resolvedDataset,
    "--limit", $effective["limit"],
    "--offset", $effective["offset"],
    "--stride", $effective["stride"],
    "--time", $effective["time"],
    "--depth", $effective["depth"],
    "--multipv", $effective["multipv"],
    "--threads", $effective["threads"],
    "--hash-mb", $effective["hashMB"],
    "--workers", $effective["workers"],
    "--status-every", $effective["statusEvery"],
    "--checkpoint-every", $effective["checkpointEvery"],
    "--dashboard-port", $effective["dashboardPort"],
    "--state-file", $stateFile,
    "--results-csv", $resultsCsv,
    "--misses-csv", $missesCsv,
    "--json-out", $summaryJson
)

if (-not [string]::IsNullOrWhiteSpace($effective["engine"])) {
    $resolvedEngine = Resolve-RepoPath ([string]$effective["engine"])
    $command += @("--engine", $resolvedEngine)
}

if ($effective["resume"]) {
    $command += "--resume"
}
if ($effective["openDashboard"] -and $effective["dashboardPort"] -gt 0) {
    $command += "--open-dashboard"
}

Write-Host ""
Write-Host "Running Bookup brilliant regression..." -ForegroundColor Cyan
Write-Host "Settings:        $settingsPath"
Write-Host "Dataset:         $resolvedDataset"
Write-Host "Output:          $resolvedOutputDir"
Write-Host "Resume:          $($effective["resume"])"
Write-Host "Engine:          $($effective["engine"])"
Write-Host "Time:            $($effective["time"]) sec"
Write-Host "Depth:           $($effective["depth"])"
Write-Host "MultiPV:         $($effective["multipv"])"
Write-Host "Threads:         $($effective["threads"])"
Write-Host "Hash MB:         $($effective["hashMB"])"
Write-Host "Workers:         $($effective["workers"])"
Write-Host "Status every:    $($effective["statusEvery"])"
Write-Host "Checkpoint every:$($effective["checkpointEvery"])"
Write-Host "Dashboard port:  $($effective["dashboardPort"])"
Write-Host "Open dashboard:  $($effective["openDashboard"])"
Write-Host ""

& $command[0] $command[1..($command.Length - 1)]

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "State:     $stateFile"
Write-Host "Results:   $resultsCsv"
Write-Host "Misses:    $missesCsv"
Write-Host "Summary:   $summaryJson"
