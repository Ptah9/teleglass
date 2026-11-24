# Crop a band of a glasses frame and scale it up for inspection.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# Usage: crop.ps1 -Name f2-listening-late -Y0 100 -Y1 165 -Scale 3
param(
  [string]$Name = 'shot',
  [int]$Y0 = 0,
  [int]$Y1 = 288,
  [int]$Scale = 3
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$shots = Join-Path $env:LOCALAPPDATA 'Temp\opencode\teleglass-shots'
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $shots "$Name-view.png"))
try {
  $h = $Y1 - $Y0
  $w = $src.Width
  $dst = New-Object System.Drawing.Bitmap($w, $h)
  try {
    for ($y = 0; $y -lt $h; $y++) {
      for ($x = 0; $x -lt $w; $x++) {
        $dst.SetPixel($x, $y, $src.GetPixel($x, $Y0 + $y))
      }
    }
    $big = New-Object System.Drawing.Bitmap(($w * $Scale), ($h * $Scale))
    try {
      $g = [System.Drawing.Graphics]::FromImage($big)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.DrawImage($dst, 0, 0, $big.Width, $big.Height)
      } finally { $g.Dispose() }
      $out = Join-Path $shots "$Name-band.png"
      $big.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output $out
    } finally { $big.Dispose() }
  } finally { $dst.Dispose() }
} finally { $src.Dispose() }
