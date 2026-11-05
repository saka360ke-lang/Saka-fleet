# Saka Fleet — brand asset builder (v1.61.6)
# Rebuilds every logo surface from the supplied master artwork
# (landing/assets/img/brand-master.png: white SAKAFLEET lockup on black).
# Pure System.Drawing, no external tools.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build_brand_assets.ps1
#
# Outputs (landing/assets/img/): logo-lockup.png, logo-mark.png, logo.svg,
# favicon.svg, favicon-32.png, apple-touch-icon.png, og-cover.png, og-cover.svg

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$imgDir = Join-Path $root 'landing\assets\img'
$masterPath = Join-Path $imgDir 'brand-master.png'
if (-not (Test-Path -LiteralPath $masterPath)) { throw "Missing master artwork: $masterPath" }

$master = [System.Drawing.Bitmap]::FromFile($masterPath)
$W = $master.Width; $H = $master.Height

# --- 1. ink bounding box (any pixel brighter than 24/255) -------------------
$minX = $W; $minY = $H; $maxX = -1; $maxY = -1
$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$data = $master.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $H)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$master.UnlockBits($data)
for ($y = 0; $y -lt $H; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $W; $x++) {
    $i = $row + ($x * 4)
    $lum = ($bytes[$i + 2] * 299 + $bytes[$i + 1] * 587 + $bytes[$i] * 114) / 1000
    if ($lum -gt 24) {
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0) { throw 'The master artwork appears to be empty (no ink found).' }
$bboxW = $maxX - $minX + 1
$bboxH = $maxY - $minY + 1
Write-Host "master ${W}x${H} | ink ${bboxW}x${bboxH} at ($minX,$minY) | ratio $([math]::Round($bboxW / $bboxH, 3))"

# --- 2. white-on-transparent crop ------------------------------------------
function New-WhiteOnTransparent([System.Drawing.Bitmap]$src, [int]$sx, [int]$sy, [int]$w, [int]$h) {
  $out = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $p = $src.GetPixel($sx + $x, $sy + $y)
      $lum = [int](($p.R * 299 + $p.G * 587 + $p.B * 114) / 1000)
      if ($lum -le 0) { continue }
      $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($lum, 255, 255, 255))
    }
  }
  return $out
}

$lockup = New-WhiteOnTransparent $master $minX $minY $bboxW $bboxH


# --- 3. the mark = first ink island (left) separated by a clear gap --------
$gapNeeded = [int][math]::Max(6, [math]::Round($bboxH * 0.10))
$run = 0; $markEnd = -1; $seenInk = $false
for ($x = 0; $x -lt $bboxW; $x++) {
  $inked = $false
  for ($y = 0; $y -lt $bboxH; $y++) {
    if ($lockup.GetPixel($x, $y).A -gt 24) { $inked = $true; break }
  }
  if ($inked) { $seenInk = $true; $run = 0 } elseif ($seenInk) {
    $run++
    if ($run -ge $gapNeeded) { $markEnd = $x - $run; break }
  }
}
if ($markEnd -lt [int]($bboxW * 0.05)) { $markEnd = [int]($bboxW * 0.16) }
$mTop = $bboxH; $mBot = -1
for ($y = 0; $y -lt $bboxH; $y++) {
  $hit = $false
  for ($x = 0; $x -le $markEnd; $x++) {
    if ($lockup.GetPixel($x, $y).A -gt 24) { $hit = $true; break }
  }
  if ($hit) { if ($y -lt $mTop) { $mTop = $y }; if ($y -gt $mBot) { $mBot = $y } }
}
$markW = $markEnd + 1; $markH = $mBot - $mTop + 1
Write-Host "mark ${markW}x${markH} at y=$mTop (wordmark begins near x=$markEnd)"

$markSide = [int]([math]::Max($markW, $markH) * 1.28)
$mark = New-Object System.Drawing.Bitmap $markSide, $markSide, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($mark)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$dx = [int](($markSide - $markW) / 2)
$dy = [int](($markSide - $markH) / 2)
$g.DrawImage($lockup, (New-Object System.Drawing.Rectangle $dx, $dy, $markW, $markH), (New-Object System.Drawing.Rectangle 0, $mTop, $markW, $markH), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$mark512 = New-Object System.Drawing.Bitmap 512, 512, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($mark512)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($mark, 0, 0, 512, 512)
$g.Dispose()

# --- 4. lockup png + mark png ----------------------------------------------
$lockupOut = New-Object System.Drawing.Bitmap $bboxW, $bboxH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($lockupOut)
$g.DrawImage($lockup, 0, 0, $bboxW, $bboxH)
$g.Dispose()
$lockupOut.Save((Join-Path $imgDir 'logo-lockup.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$mark512.Save((Join-Path $imgDir 'logo-mark.png'), [System.Drawing.Imaging.ImageFormat]::Png)

function ConvertTo-Base64([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return [Convert]::ToBase64String($ms.ToArray())
}

# --- 5. icon tiles (black rounded canvas + white mark) ---------------------
function New-IconTile([int]$size, [string]$file) {
  $tile = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($tile)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 10, 10, 12))
  $g.FillPath($brush, $path)
  $pad = [int]($size * 0.20)
  $inner = $size - ($pad * 2)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($mark512, $pad, $pad, $inner, $inner)
  $g.Dispose()
  $tile.Save((Join-Path $imgDir $file), [System.Drawing.Imaging.ImageFormat]::Png)
}
New-IconTile 32 'favicon-32.png'
New-IconTile 180 'apple-touch-icon.png'

# --- 6. svg surfaces --------------------------------------------------------
$logoWidth = $bboxW
$logoHeight = $bboxH
$lockupB64 = ConvertTo-Base64 $lockupOut
$markB64 = ConvertTo-Base64 $mark512
$svg = "<svg xmlns=`"http://www.w3.org/2000/svg`" viewBox=`"0 0 $logoWidth $logoHeight`" role=`"img`" aria-label=`"Saka Fleet`"><image width=`"$logoWidth`" height=`"$logoHeight`" href=`"data:image/png;base64,$lockupB64`"/></svg>"
Set-Content -LiteralPath (Join-Path $imgDir 'logo.svg') -Value $svg -Encoding UTF8 -NoNewline
$faviconSvg = "<svg xmlns=`"http://www.w3.org/2000/svg`" viewBox=`"0 0 64 64`" role=`"img`" aria-label=`"Saka Fleet`"><rect width=`"64`" height=`"64`" rx=`"14`" fill=`"#0A0A0C`"/><image x=`"9`" y=`"9`" width=`"46`" height=`"46`" href=`"data:image/png;base64,$markB64`"/></svg>"
Set-Content -LiteralPath (Join-Path $imgDir 'favicon.svg') -Value $faviconSvg -Encoding UTF8 -NoNewline

# --- 7. OG cover (1200x630) -------------------------------------------------
$ogW = 1200; $ogH = 630
$og = New-Object System.Drawing.Bitmap $ogW, $ogH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($og)
$g.Clear([System.Drawing.Color]::FromArgb(255, 10, 10, 12))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$targetW = 820
$targetH = [int][math]::Round($targetW * $bboxH / $bboxW)
$tx = [int](($ogW - $targetW) / 2)
$ty = [int](($ogH - $targetH) / 2)
$g.DrawImage($lockupOut, $tx, $ty, $targetW, $targetH)
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 198, 255, 61))
$g.FillRectangle($accent, $tx, ($ty + $targetH + 46), 120, 4)
$g.Dispose()
$og.Save((Join-Path $imgDir 'og-cover.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$ogB64 = ConvertTo-Base64 $og
$ogSvg = "<svg xmlns=`"http://www.w3.org/2000/svg`" viewBox=`"0 0 1200 630`" role=`"img`" aria-label=`"Saka Fleet`"><image width=`"1200`" height=`"630`" href=`"data:image/png;base64,$ogB64`"/></svg>"
Set-Content -LiteralPath (Join-Path $imgDir 'og-cover.svg') -Value $ogSvg -Encoding UTF8 -NoNewline

$master.Dispose()
Write-Host "logo.svg viewBox = 0 0 $logoWidth $logoHeight (ratio $([math]::Round($logoWidth / $logoHeight, 3)))"
Write-Host 'Brand assets rebuilt from brand-master.png.'

