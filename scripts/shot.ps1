# Glasses screenshot from the simulator + conversion of the frame to a normal PNG.
#
# Why: the automation API returns RGBA where brightness sits in alpha (RGB is
# always 0,255,0). The background is alpha 0. In a regular viewer such a file
# looks empty or black, while models/eyes need an opaque frame.
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#
# Usage:
#   powershell -File scripts/shot.ps1 -Name chats
#   powershell -File scripts/shot.ps1 -Name reply -Port 9898
#
# Output: $env:LOCALAPPDATA\Temp\opencode\teleglass-shots\<Name>.png (raw)
#         and <Name>-view.png (opaque: green on black).

param(
  [string]$Name = 'shot',
  [int]$Port = 9898
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$shots = Join-Path $env:LOCALAPPDATA 'Temp\opencode\teleglass-shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null

$raw = Join-Path $shots "$Name.png"
$view = Join-Path $shots "$Name-view.png"
$url = "http://127.0.0.1:$Port/api/screenshot/glasses"

Invoke-WebRequest -Uri $url -OutFile $raw -TimeoutSec 10 | Out-Null

$src = [System.Drawing.Bitmap]::FromFile($raw)
try {
  $dst = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    for ($y = 0; $y -lt $src.Height; $y++) {
      for ($x = 0; $x -lt $src.Width; $x++) {
        $p = $src.GetPixel($x, $y)
        # Brightness = alpha (the frame RGB is always pure green).
        $v = $p.A
        $dst.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, $v, 0))
      }
    }
    $dst.Save($view, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $dst.Dispose() }
} finally { $src.Dispose() }

"raw:  $raw"
"view: $view"
