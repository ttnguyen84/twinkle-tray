param(
    [switch]$SkipInstall,
    [switch]$OpenOutput
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Npm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Find-Python {
    $pythonPath = Join-Path $env:LocalAppData "Programs\Python\Python*\python.exe"
    $installedPython = Get-ChildItem -Path $pythonPath -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1

    if ($installedPython) {
        return $installedPython.FullName
    }

    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand -and $pythonCommand.Source -notlike "*\WindowsApps\*") {
        return $pythonCommand.Source
    }

    return $null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is not available in PATH."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is not available in PATH."
}

if (-not $env:PYTHON) {
    $env:PYTHON = Find-Python
}

if (-not $env:PYTHON -or -not (Test-Path -LiteralPath $env:PYTHON)) {
    throw "Python 3 is required to build native modules. Install Python and try again."
}

Write-Host "Using Python: $env:PYTHON"

if (-not $SkipInstall) {
    Invoke-Npm install --package-lock=false --no-audit --no-fund
}

Invoke-Npm run test-light-sensor
Invoke-Npm run parcel-build
Invoke-Npm run electron-build

$outputPath = Join-Path $repoRoot "dist"
Write-Host "Build completed: $outputPath" -ForegroundColor Green

if ($OpenOutput -and (Test-Path $outputPath)) {
    Invoke-Item $outputPath
}
