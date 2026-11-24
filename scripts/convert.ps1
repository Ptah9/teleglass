# Convert a raw glasses frame (RGBA, brightness in alpha) into an opaque preview.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# Usage: convert.ps1 -Name sw-0
param(
  [string]$Name = 'shot'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$shots = Join-Path $env:LOCALAPPDATA 'Temp\opencode\teleglass-shots'
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $shots "$Name.png"))
try {
  $dst = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    for ($y = 0; $y -lt $src.Height; $y++) {
      for ($x = 0; $x -lt $src.Width; $x++) {
        $v = $src.GetPixel($x, $y).A
        $dst.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, $v, 0))
      }
    }
    $out = Join-Path $shots "$Name-view.png"
    $dst.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output $out
  } finally { $dst.Dispose() }
} finally { $src.Dispose() }
