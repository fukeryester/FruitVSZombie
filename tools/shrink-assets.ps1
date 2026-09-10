# 水果贴图降采样
# ------------------------------------------------------------------
# Assets/pic 下的水果贴图是 2048x2048（每张 3MB 左右），但游戏里最大
# 只画到直径约 180 设计单位（≈360 设备 px），2048 纯属浪费：
# 网页版整包会涨到 30MB+，手机端首次加载和解码都很痛。
# 这里统一降到 512x512（仍有 ~1.4 倍余量），整包回落到 2MB 级别。
#
# 用法：powershell -ExecutionPolicy Bypass -File tools/shrink-assets.ps1 [-MaxSize 512]

param(
  [int]$MaxSize = 512,
  [string]$Dir = "Assets/pic"
)

Add-Type -AssemblyName System.Drawing

$files = Get-ChildItem -Path $Dir -Filter *.png
$savedTotal = 0

foreach ($f in $files) {
  $img = [System.Drawing.Image]::FromFile($f.FullName)
  $w = $img.Width
  $h = $img.Height
  if ($w -le $MaxSize -and $h -le $MaxSize) {
    $img.Dispose()
    Write-Host ("skip  {0,-24} {1}x{2}" -f $f.Name, $w, $h)
    continue
  }

  $scale = [Math]::Min($MaxSize / $w, $MaxSize / $h)
  $nw = [int][Math]::Round($w * $scale)
  $nh = [int][Math]::Round($h * $scale)

  $bmp = New-Object System.Drawing.Bitmap($nw, $nh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $nw, $nh)))
  $g.Dispose()
  $img.Dispose()

  $before = $f.Length
  $tmp = "$($f.FullName).tmp"
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Move-Item -Force $tmp $f.FullName
  $after = (Get-Item $f.FullName).Length
  $savedTotal += ($before - $after)
  Write-Host ("shrink {0,-24} {1}x{2} -> {3}x{4}  {5:N2}MB -> {6:N2}MB" -f `
    $f.Name, $w, $h, $nw, $nh, ($before / 1MB), ($after / 1MB))
}

Write-Host ("`n共省下 {0:N2} MB" -f ($savedTotal / 1MB))
