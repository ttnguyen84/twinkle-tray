param(
    [ValidateSet("Status", "Off", "Low", "High", "Auto", "Cycle")]
    [string]$Action = "Status",

    [ValidateRange(250, 10000)]
    [int]$DelayMilliseconds = 1200
)

$ErrorActionPreference = "Stop"

$addinRoot = Join-Path $env:ProgramData "Lenovo\Vantage\Addins\IdeaNotebookAddin"
$addinDirectory = Get-ChildItem -LiteralPath $addinRoot -Directory -ErrorAction Stop |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1

if (-not $addinDirectory) {
    throw "Lenovo IdeaNotebookAddin is not installed."
}

Get-ChildItem -LiteralPath $addinDirectory.FullName -Filter "*.dll" | ForEach-Object {
    try { [void][Reflection.Assembly]::LoadFrom($_.FullName) } catch {}
}

$contract = [Reflection.Assembly]::LoadFrom((Join-Path $addinDirectory.FullName "KeyboardContract.dll"))
$addin = [Reflection.Assembly]::LoadFrom((Join-Path $addinDirectory.FullName "IdeaNotebookAddin.dll"))
$handler = $addin.GetType("IdeaNotebookAddin.ContractHandlers.KeyboardHandler", $true)
$keyboard = $handler.GetField("keyboard", [Reflection.BindingFlags]"NonPublic,Static").GetValue($null)

function Get-KeyboardBacklightStatus {
    $response = $handler.GetMethod("GetBacklightStatus").Invoke($null, @())
    $values = @{}

    foreach ($item in $response.List.Items) {
        $values[$item.key] = $item.value
    }

    return $values
}

function Set-KeyboardBacklightLevel([string]$level) {
    $requestType = $contract.GetType("Lenovo.Modern.Contracts.Keyboard.KeyboardSettingsRequest", $true)
    $listType = $contract.GetType("Lenovo.Modern.Contracts.Keyboard.SettingList", $true)
    $settingType = $contract.GetType("Lenovo.Modern.Contracts.Keyboard.Setting", $true)
    $xmlBooleanType = $contract.GetType("Lenovo.Modern.Contracts.Keyboard.XMLBoolean", $true)

    $request = [Activator]::CreateInstance($requestType)
    $list = [Activator]::CreateInstance($listType)
    $setting = [Activator]::CreateInstance($settingType)
    $items = [Activator]::CreateInstance($listType.GetProperty("Items").PropertyType)

    $setting.key = "KeyboardBacklightStatus"
    $setting.value = $level
    $setting.enabled = [Enum]::Parse($xmlBooleanType, "True")
    [void]$items.Add($setting)
    $list.Items = $items
    $request.List = $list

    $interface = $addin.GetType("IdeaNotebookAddin.IKeyboard", $true)
    $result = $interface.GetMethod("SetBacklightStatus").Invoke($keyboard, @($request))

    if ($result.ErrorCode -ne "Success") {
        throw "Lenovo returned: $($result.ErrorCode)"
    }

    $current = Get-KeyboardBacklightStatus
    if ($current.KeyboardBacklightStatus -ne $level) {
        throw "Requested $level but read back $($current.KeyboardBacklightStatus)."
    }

    Write-Host "Keyboard backlight: $level" -ForegroundColor Green
}

$supported = $handler.GetMethod("IsSupportBacklight").Invoke($null, @())
$levels = $handler.GetMethod("GetKblLevels").Invoke($null, @())
$status = Get-KeyboardBacklightStatus

Write-Host "Supported: $supported"
Write-Host "States: $levels"
Write-Host "Capability: $($status.KeyboardBacklightLevel)"
Write-Host "Current: $($status.KeyboardBacklightStatus)"

if (-not $supported) {
    throw "Keyboard backlight is not supported by the Lenovo driver."
}

$levelMap = @{
    Off = "Off"
    Low = "Level_1"
    High = "Level_2"
    Auto = "Auto"
}

if ($Action -eq "Cycle") {
    $originalLevel = $status.KeyboardBacklightStatus

    try {
        foreach ($level in @("Off", "Level_1", "Level_2")) {
            Set-KeyboardBacklightLevel $level
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    } finally {
        Set-KeyboardBacklightLevel $originalLevel
    }
} elseif ($Action -ne "Status") {
    Set-KeyboardBacklightLevel $levelMap[$Action]
}
