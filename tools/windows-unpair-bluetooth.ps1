<#
.SYNOPSIS
  Lists or removes (unpairs) paired Bluetooth devices on Windows -- for
  clearing a stale Meshtastic pairing after a factory reset.

.DESCRIPTION
  Meshtastic's factory reset wipes the device's own Bluetooth bonding
  keys along with everything else, but Windows' side of that bond is
  untouched -- the two are now mismatched, so Windows fails to reconnect
  until the device is removed from its paired-devices list and re-paired
  from scratch.

  Web Bluetooth (the API MeshFleet's browser side uses) has no
  permission to remove OS-level Bluetooth pairings -- that's a
  deliberate browser security boundary, not something the web app can
  automate around. This script does the removal from PowerShell instead,
  via each device's Bluetooth PnP entry (Remove-PnpDevice), which is the
  standard command-line way to unpair a Bluetooth device on Windows
  10/11. Equivalent manual steps: Settings > Bluetooth & devices > click
  the device > Remove device.

  Without -Remove, this only lists what would be removed -- review the
  list before re-running with -Remove.

.PARAMETER Filter
  A case-insensitive substring to match against each paired device's
  name. Defaults to "Meshtastic", matching the firmware's default BLE
  advertised name (Meshtastic_XXXX). Pass "*" to list every paired
  Bluetooth device, or a specific name if you've renamed the device.

.PARAMETER Remove
  Actually unpair the matched device(s). Requires an elevated
  (Administrator) PowerShell -- Remove-PnpDevice needs it.

.EXAMPLE
  # Dry run: see what would be removed
  .\windows-unpair-bluetooth.ps1

.EXAMPLE
  # Unpair every paired device with "Meshtastic" in its name
  .\windows-unpair-bluetooth.ps1 -Remove

.EXAMPLE
  # List every paired Bluetooth device, to find one that's been renamed
  .\windows-unpair-bluetooth.ps1 -Filter "*"
#>
#Requires -RunAsAdministrator

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Filter = "Meshtastic",
    [switch]$Remove
)

if (-not (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue)) {
    # PnpDevice is a CDXML module built into Windows 10/11; PowerShell 7+
    # needs an explicit compat-mode import to load it.
    Import-Module PnpDevice -UseWindowsPowerShell -ErrorAction SilentlyContinue
}
if (-not (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue)) {
    Write-Error "Get-PnpDevice isn't available. This script needs Windows 10 (1809+) or Windows 11."
    exit 1
}

$devices = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -and $_.FriendlyName -like "*$Filter*" }

if (-not $devices) {
    Write-Host "No paired Bluetooth devices matched '*$Filter*'." -ForegroundColor Yellow
    Write-Host "Run with -Filter '*' to list every paired Bluetooth device and find the right name."
    exit 0
}

Write-Host "Matched device(s):"
$devices | Format-Table FriendlyName, InstanceId, Status -AutoSize

if (-not $Remove) {
    Write-Host "`nDry run only -- re-run with -Remove to actually unpair these." -ForegroundColor Cyan
    exit 0
}

foreach ($d in $devices) {
    if ($PSCmdlet.ShouldProcess($d.FriendlyName, "Remove (unpair) Bluetooth device")) {
        Write-Host "Removing $($d.FriendlyName) ($($d.InstanceId)) ..."
        Remove-PnpDevice -InstanceId $d.InstanceId -Confirm:$false
    }
}

Write-Host "`nDone. If Settings > Bluetooth & devices still lists the device, toggle the Bluetooth radio off and " `
    "on once to flush the cache, then reconnect from MeshFleet to re-pair from scratch." -ForegroundColor Green
