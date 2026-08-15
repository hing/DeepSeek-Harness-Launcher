# 生成应用图标：256x256 PNG + 同尺寸 PNG 压缩的 .ico（Vista+ 支持）
# 输出：app\build\icon.png 与 app\build\icon.ico
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root 'app\build'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
$pngPath = Join-Path $iconDir 'icon.png'
$icoPath = Join-Path $iconDir 'icon.ico'

Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 深蓝圆角方块
$radius = 48
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 23, 78, 198))
$g.FillPath($brush, $path)

# 白色 "DSH" 字样
$font = New-Object System.Drawing.Font('Segoe UI', 92, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$text = 'DSH'
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, 2, $size, $size)
$g.DrawString($text, $font, [System.Drawing.Brushes]::White, $rect, $fmt)

$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# 打包为多尺寸 ICO（16/32/48/64/128/256，各条目为 PNG 压缩；NSIS 安装器需要多尺寸）
$sizes = @(16, 32, 48, 64, 128, 256)
$entries = foreach ($s in $sizes) {
    $rb = New-Object System.Drawing.Bitmap $s, $s
    $rg = [System.Drawing.Graphics]::FromImage($rb)
    $rg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $rg.DrawImage($bmp, 0, 0, $s, $s)
    $rg.Dispose()
    $em = New-Object System.IO.MemoryStream
    $rb.Save($em, [System.Drawing.Imaging.ImageFormat]::Png)
    $rb.Dispose()
    , @($s, $em.ToArray())
}
$g.Dispose(); $bmp.Dispose()
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)                          # reserved
$bw.Write([UInt16]1)                          # type: icon
$bw.Write([UInt16]$entries.Count)             # count
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $s = $e[0]; $bytes = $e[1]
    $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))   # width
    $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))   # height
    $bw.Write([Byte]0)                        # colors
    $bw.Write([Byte]0)                        # reserved
    $bw.Write([UInt16]1)                      # planes
    $bw.Write([UInt16]32)                     # bit count
    $bw.Write([UInt32]$bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($e in $entries) { $bw.Write($e[1]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Write-Host "图标已生成：$pngPath / $icoPath"

# ---- 启动画面（portable 解压期间显示）----
$splashPath = Join-Path $iconDir 'splash.bmp'
$w = 560; $h = 320
$bmp2 = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g2.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 20, 32))
$g2.FillRectangle($bg, 0, 0, $w, $h)
# 顶部装饰条
$bar = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 23, 78, 198))
$g2.FillRectangle($bar, 0, 0, $w, 6)
# 标题
$f1 = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$f2 = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$f3 = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$gray = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 150, 158, 175))
$fmt2 = New-Object System.Drawing.StringFormat
$fmt2.Alignment = [System.Drawing.StringAlignment]::Center
$g2.DrawString('DSHL', $f1, $white, (New-Object System.Drawing.RectangleF(0, 90, $w, 46)), $fmt2)
$g2.DrawString('DeepSeek Harness Launcher · 正在启动 DeepSeek Harness ...', $f2, $gray, (New-Object System.Drawing.RectangleF(0, 150, $w, 30)), $fmt2)
$g2.DrawString('首次启动需解压运行环境，请稍候（约 1-3 分钟）', $f3, $gray, (New-Object System.Drawing.RectangleF(0, 200, $w, 26)), $fmt2)
$bmp2.Save($splashPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$g2.Dispose(); $bmp2.Dispose()
Write-Host "启动画面已生成：$splashPath"
