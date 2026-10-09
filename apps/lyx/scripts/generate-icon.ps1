Add-Type -AssemblyName System.Drawing
$s = 256
$bmp = New-Object System.Drawing.Bitmap($s, $s)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$rect = New-Object System.Drawing.Rectangle(8, 8, ($s - 16), ($s - 16))
$radius = 44
$p = New-Object System.Drawing.Drawing2D.GraphicsPath
$p.AddArc($rect.X, $rect.Y, ($radius * 2), ($radius * 2), 180, 90)
$p.AddArc(($rect.Right - $radius * 2), $rect.Y, ($radius * 2), ($radius * 2), 270, 90)
$p.AddArc(($rect.Right - $radius * 2), ($rect.Bottom - $radius * 2), ($radius * 2), ($radius * 2), 0, 90)
$p.AddArc($rect.X, ($rect.Bottom - $radius * 2), ($radius * 2), ($radius * 2), 90, 90)
$p.CloseFigure()
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 59, 110, 165))
$g.FillPath($bg, $p)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 47, 88, 132), 6)
$g.DrawPath($pen, $p)
$font = New-Object System.Drawing.Font('Segoe UI', 150, [System.Drawing.FontStyle]::Bold)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'
$fmt.LineAlignment = 'Center'
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.DrawString('L', $font, $white, (New-Object System.Drawing.RectangleF(0, -10, $s, $s)), $fmt)
$g.Dispose()
$bmp.Save("$PSScriptRoot\..\build\icon-256.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"icon written: $((Get-Item "$PSScriptRoot\..\build\icon-256.png").Length) bytes"