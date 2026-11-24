# Capture a burst of glasses frames to see a transition frame by frame.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# Usage: burst.ps1 -Name sw -Count 6 -DelayMs 80
param(
  [string]$Name = 'burst',
  [int]$Count = 6,
  [int]$DelayMs = 80,
  [int]$Port = 9898
)

$ErrorActionPreference = 'Stop'
$shots = Join-Path $env:LOCALAPPDATA 'Temp\opencode\teleglass-shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$url = "http://127.0.0.1:$Port/api/screenshot/glasses"

for ($i = 0; $i -lt $Count; $i++) {
  $file = Join-Path $shots ("{0}-{1}.png" -f $Name, $i)
  Invoke-WebRequest -Uri $url -OutFile $file -TimeoutSec 10 | Out-Null
  if ($i -lt $Count - 1) { Start-Sleep -Milliseconds $DelayMs }
}
Write-Output ("captured {0} frames as {1}-*.png" -f $Count, $Name)
