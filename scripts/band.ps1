# Measure the brightest pixel in a horizontal band of a glasses frame.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# Usage: band.ps1 -Name f2-listening-late -Y0 100 -Y1 165
param(
  [string]$Name = 'shot',
  [int]$Y0 = 0,
  [int]$Y1 = 288
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$shots = Join-Path $env:LOCALAPPDATA 'Temp\opencode\teleglass-shots'
$path = Join-Path $shots "$Name.png"
$b = [System.Drawing.Bitmap]::FromFile($path)
try {
  $max = 0
  $lit = 0
  for ($y = $Y0; $y -lt $Y1; $y++) {
    for ($x = 0; $x -lt $b.Width; $x++) {
      $a = $b.GetPixel($x, $y).A
      if ($a -gt $max) { $max = $a }
      if ($a -gt 0) { $lit++ }
    }
  }
  Write-Output ("band {0}..{1}: max alpha {2}, lit {3}" -f $Y0, $Y1, $max, $lit)
} finally { $b.Dispose() }
