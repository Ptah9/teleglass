# Press: send a touchpad action to the simulator and (optionally) snapshot.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# Usage: press.ps1 -Action down -Times 3 -Shot after-scroll
param(
  [string]$Action = 'down',
  [int]$Times = 1,
  [string]$Shot = '',
  [int]$Port = 9898
)

$base = "http://127.0.0.1:$Port"

for ($i = 0; $i -lt $Times; $i++) {
  $body = @{ action = $Action } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Uri "$base/api/input" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 5 | Out-Null
  } catch {
    "input $Action #$i failed: $($_.Exception.Message)"
    exit 1
  }
  "sent: $Action"
  Start-Sleep -Milliseconds 450
}

if ($Shot -ne '') {
  Start-Sleep -Milliseconds 300
  & (Join-Path $PSScriptRoot 'shot.ps1') -Name $Shot -Port $Port
}
