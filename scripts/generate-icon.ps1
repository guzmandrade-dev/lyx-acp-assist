# Draws the LyX ACP Assist logo and writes build/icon.ico (16/32/48/64/256
# PNG-compressed entries) plus build/icon-256.png (UI/README raster).
# The design mirrors public/logo.svg: a tilted paper card with a LyX-blue
# title bar, a yellow highlight stroke (the agent's edit), and a red AI
# spark - the LyX wordmark palette. Run on Windows:
#   powershell -File scripts/generate-icon.ps1
Add-Type -AssemblyName System.Drawing

$buildDir = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$script:blue  = [System.Drawing.Color]::FromArgb(255, 59, 110, 165)  # LyX blue (app accent)
$script:yellow = [System.Drawing.Color]::FromArgb(255, 240, 180, 41) # LyX yellow
$script:red   = [System.Drawing.Color]::FromArgb(255, 217, 79, 43)   # LyX red
$script:paper = [System.Drawing.Color]::FromArgb(255, 250, 248, 242)
$script:paperEdge = [System.Drawing.Color]::FromArgb(255, 216, 210, 196)
$script:ink   = [System.Drawing.Color]::FromArgb(255, 138, 133, 120) # muted text lines
$script:white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

function Add-RoundedRect {
  param($Path, [float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)
  $d = $R * 2
  $Path.AddArc($X, $Y, $d, $d, 180, 90)
  $Path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $Path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $Path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $Path.CloseFigure()
}

# All geometry lives in a 256x256 design space; callers scale the transform.
function Draw-Logo([System.Drawing.Graphics]$g) {
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  # Paper card, tilted slightly.
  $state = $g.Save()
  $g.TranslateTransform(128, 128)
  $g.RotateTransform(-6)
  $g.TranslateTransform(-128, -128)
  $card = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect $card 56 44 144 168 18
  $g.FillPath((New-Object System.Drawing.SolidBrush($script:paper)), $card)
  $g.DrawPath((New-Object System.Drawing.Pen($script:paperEdge, 3)), $card)

  # Title bar (LyX blue).
  $title = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect $title 76 72 80 14 7
  $g.FillPath((New-Object System.Drawing.SolidBrush($script:blue)), $title)

  # Muted body-text lines.
  foreach ($l in @(@(76, 100, 104, 8), @(76, 116, 88, 8), @(76, 164, 72, 8))) {
    $line = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect $line $l[0] $l[1] $l[2] $l[3] 4
    $g.FillPath((New-Object System.Drawing.SolidBrush($script:ink)), $line)
  }

  # Yellow highlight stroke (the agent's edit).
  $hl = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect $hl 76 140 96 12 6
  $g.FillPath((New-Object System.Drawing.SolidBrush($script:yellow)), $hl)
  $g.Restore($state)

  # AI spark, upright, overlapping the card's top-right corner.
  $star = New-Object System.Drawing.Drawing2D.GraphicsPath
  $star.AddPolygon([System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF(188, 28)),
    (New-Object System.Drawing.PointF(196, 54)),
    (New-Object System.Drawing.PointF(222, 62)),
    (New-Object System.Drawing.PointF(196, 70)),
    (New-Object System.Drawing.PointF(188, 96)),
    (New-Object System.Drawing.PointF(180, 70)),
    (New-Object System.Drawing.PointF(154, 62)),
    (New-Object System.Drawing.PointF(180, 54))
  ))
  $g.DrawPath((New-Object System.Drawing.Pen($script:white, 5)), $star)
  $g.FillPath((New-Object System.Drawing.SolidBrush($script:red)), $star)
}

$sizes = @(16, 32, 48, 64, 256)
$pngs = @{}
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.ScaleTransform($s / 256.0, $s / 256.0)
  Draw-Logo $g
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs[$s] = $ms.ToArray()
  $ms.Dispose()
  if ($s -eq 256) {
    $bmp.Save((Join-Path $buildDir 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $bmp.Dispose()
}

# ICO = header + directory + PNG-compressed payloads (Vista+; Chromium and
# electron-builder both read this form).
$icoPath = Join-Path $buildDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$w = New-Object System.IO.BinaryWriter($fs)
$w.Write([UInt16]0)             # reserved
$w.Write([UInt16]1)             # type: icon
$w.Write([UInt16]$sizes.Count)  # image count
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
  $data = $pngs[$s]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$dim)          # width (0 means 256)
  $w.Write([byte]$dim)          # height
  $w.Write([byte]0)             # palette
  $w.Write([byte]0)             # reserved
  $w.Write([UInt16]1)           # color planes
  $w.Write([UInt16]32)          # bits per pixel
  $w.Write([UInt32]$data.Length)
  $w.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($s in $sizes) {
  $w.Write($pngs[$s])
}
$w.Dispose()
$fs.Dispose()

"icon written: $icoPath ($((Get-Item $icoPath).Length) bytes), plus build\icon-256.png"
