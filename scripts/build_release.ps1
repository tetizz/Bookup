param(
    [string]$Version = "dev",
    [switch]$SkipPythonInstall,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ReleaseDir = Join-Path $Root "release"
$PortableDir = Join-Path $ReleaseDir "Bookup"
$PortableZip = Join-Path $ReleaseDir "Bookup-Windows-$Version-portable.zip"
$InstallerScript = Join-Path $Root "installer\Bookup.iss"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )
    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Body
}

function Get-InnoSetupCompiler {
    $candidates = @()
    $command = Get-Command "iscc.exe" -ErrorAction SilentlyContinue
    if ($command) {
        $candidates += $command.Source
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe")
    }
    return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function Set-PythonCommand {
    $py = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if ($py) {
        & $py.Source -3.13 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 13) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $script:PythonExe = $py.Source
            $script:PythonArgs = @("-3.13")
            return
        }
    }

    $python = Get-Command "python.exe" -ErrorAction Stop
    $script:PythonExe = $python.Source
    $script:PythonArgs = @()
}

function Invoke-Python {
    param([string[]]$Arguments)
    $commandArgs = @()
    $commandArgs += $script:PythonArgs
    $commandArgs += $Arguments
    & $script:PythonExe @commandArgs
}

Set-PythonCommand
if (Get-Variable PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $true
}
Write-Host "Using Python: $script:PythonExe $($script:PythonArgs -join ' ')" -ForegroundColor DarkCyan
Set-Location $Root

if (-not $SkipPythonInstall) {
    Invoke-Step "Install Python build dependencies" {
        Invoke-Python -Arguments @("-m", "pip", "install", "--upgrade", "pip")
        Invoke-Python -Arguments @("-m", "pip", "install", "-r", "requirements.txt", "pyinstaller")
    }
}

Invoke-Step "Build root-level Bookup app bundle" {
    Invoke-Python -Arguments @("package.py")
}

Invoke-Step "Create portable release zip" {
    if (Test-Path $ReleaseDir) {
        Remove-Item -LiteralPath $ReleaseDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null

    Copy-Item -LiteralPath (Join-Path $Root "Bookup.exe") -Destination $PortableDir -Force
    Copy-Item -LiteralPath (Join-Path $Root "_internal") -Destination $PortableDir -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $Root "README.md") -Destination $PortableDir -Force
    Copy-Item -LiteralPath (Join-Path $Root "LICENSE") -Destination $PortableDir -Force

    Compress-Archive -LiteralPath $PortableDir -DestinationPath $PortableZip -Force
    Write-Host "Portable zip: $PortableZip" -ForegroundColor Green
}

if (-not $SkipInstaller) {
    Invoke-Step "Create Windows installer" {
        $iscc = Get-InnoSetupCompiler
        if (-not $iscc) {
            Write-Warning "Inno Setup compiler not found. Install Inno Setup 6 or run the GitHub release workflow to produce the installer."
        } else {
            & $iscc "/DMyAppVersion=$Version" $InstallerScript
            Write-Host "Installer output: $(Join-Path $ReleaseDir "Bookup-Setup-$Version.exe")" -ForegroundColor Green
        }
    }
}

Invoke-Step "Release artifacts" {
    Get-ChildItem -LiteralPath $ReleaseDir -File | Where-Object { $_.Extension -in @(".zip", ".exe") } | ForEach-Object {
        Write-Host $_.FullName
    }
}
