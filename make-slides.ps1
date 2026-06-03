$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

function New-Slide([int]$w=1080,[int]$h=1080,[bool]$tealCorner=$true){
  $bmp = New-Object System.Drawing.Bitmap $w,$h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $rect = New-Object System.Drawing.Rectangle 0,0,$w,$h
  $b1 = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(10,14,29), [System.Drawing.Color]::FromArgb(16,23,46), [single]135)
  $g.FillRectangle($b1, $rect); $b1.Dispose()
  # Purple glow upper-right
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glow.AddEllipse($w-500,-300,800,800)
  $pb = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
  $pb.CenterColor = [System.Drawing.Color]::FromArgb(95,124,92,255)
  $pb.SurroundColors = @([System.Drawing.Color]::FromArgb(0,124,92,255))
  $g.FillPath($pb, $glow); $pb.Dispose(); $glow.Dispose()
  if($tealCorner){
    $glow2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $glow2.AddEllipse(-200,$h-400,700,700)
    $pb2 = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow2)
    $pb2.CenterColor = [System.Drawing.Color]::FromArgb(55,45,212,167)
    $pb2.SurroundColors = @([System.Drawing.Color]::FromArgb(0,45,212,167))
    $g.FillPath($pb2, $glow2); $pb2.Dispose(); $glow2.Dispose()
  }
  return @{ bmp=$bmp; g=$g; w=$w; h=$h }
}

function Draw-Centered($slide,[string]$text,[float]$y,[float]$size,[bool]$bold,$color){
  $style = if($bold){[System.Drawing.FontStyle]::Bold}else{[System.Drawing.FontStyle]::Regular}
  $font = New-Object System.Drawing.Font('Segoe UI', $size, $style)
  $br = New-Object System.Drawing.SolidBrush $color
  $sz = $slide.g.MeasureString($text, $font)
  $x = ($slide.w - $sz.Width) / 2
  $slide.g.DrawString($text, $font, $br, $x, $y)
  $font.Dispose(); $br.Dispose()
  return $sz.Width
}

function Draw-Pill($slide,[string]$text,[float]$y,$bgColor,$borderColor,$textColor,[float]$fontSize=16){
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold)
  $sz = $slide.g.MeasureString($text, $font)
  $padX = 20; $padY = 12
  $w = $sz.Width + $padX*2; $h = $sz.Height + $padY
  $x = ($slide.w - $w) / 2
  $r = $h / 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($x, $y, $r*2, $h, 90, 180)
  $path.AddArc($x + $w - $r*2, $y, $r*2, $h, 270, 180)
  $path.CloseFigure()
  $bg = New-Object System.Drawing.SolidBrush $bgColor
  $slide.g.FillPath($bg, $path); $bg.Dispose()
  $pen = New-Object System.Drawing.Pen $borderColor, 1.5
  $slide.g.DrawPath($pen, $path); $pen.Dispose()
  $br = New-Object System.Drawing.SolidBrush $textColor
  $slide.g.DrawString($text, $font, $br, $x + $padX, $y + $padY/2 - 2)
  $br.Dispose(); $font.Dispose(); $path.Dispose()
}

function Save-Slide($slide,[string]$path){
  $slide.bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $slide.g.Dispose(); $slide.bmp.Dispose()
}

# Helper - rounded rect path
function Get-RoundedPath([float]$x,[float]$y,[float]$w,[float]$h,[float]$r){
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, $r*2, $r*2, 180, 90)
  $p.AddArc($x+$w-$r*2, $y, $r*2, $r*2, 270, 90)
  $p.AddArc($x+$w-$r*2, $y+$h-$r*2, $r*2, $r*2, 0, 90)
  $p.AddArc($x, $y+$h-$r*2, $r*2, $r*2, 90, 90)
  $p.CloseFigure()
  return $p
}

# ============= SLIDE 1 — Gancho =============
$s = New-Slide
$g = $s.g
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(140,244,63,94)), 5
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pts = @(
  [System.Drawing.PointF]::new(60, 750)
  [System.Drawing.PointF]::new(200, 790)
  [System.Drawing.PointF]::new(340, 760)
  [System.Drawing.PointF]::new(480, 840)
  [System.Drawing.PointF]::new(620, 810)
  [System.Drawing.PointF]::new(760, 880)
  [System.Drawing.PointF]::new(900, 910)
  [System.Drawing.PointF]::new(1020, 950)
)
$g.DrawLines($pen, $pts); $pen.Dispose()
Draw-Pill $s "PERGUNTA HONESTA" 140 ([System.Drawing.Color]::FromArgb(40,154,124,255)) ([System.Drawing.Color]::FromArgb(120,154,124,255)) ([System.Drawing.Color]::FromArgb(220,205,188,255)) 16
$white = [System.Drawing.Color]::White
$purple = [System.Drawing.Color]::FromArgb(160,130,255)
Draw-Centered $s "VOC$([char]0x00CA) SABE" 260 84 $true $white
Draw-Centered $s "SE EST$([char]0x00C1) NO LUCRO" 360 80 $true $white
Draw-Centered $s "COM APOSTAS?" 460 80 $true $purple
Draw-Centered $s "Sem anota$([char]0x00E7)$([char]0x00E3)o, n$([char]0x00E3)o d$([char]0x00E1) pra saber." 620 26 $false ([System.Drawing.Color]::FromArgb(180,174,184,214))
Save-Slide $s "C:\Users\loamy\Downloads\apostack-slide-1.png"
"Slide 1 ok"

# ============= SLIDE 3 — Features =============
$s = New-Slide
$g = $s.g
$white = [System.Drawing.Color]::White
Draw-Pill $s "O QUE A APOSTACK FAZ" 110 ([System.Drawing.Color]::FromArgb(40,154,124,255)) ([System.Drawing.Color]::FromArgb(120,154,124,255)) ([System.Drawing.Color]::FromArgb(220,205,188,255)) 16
Draw-Centered $s "TUDO QUE VOC$([char]0x00CA) PRECISA" 200 56 $true $white
Draw-Centered $s "NUMA TELA S$([char]0x00D3)" 270 56 $true $white

$features = @(
  @{ name='Banca em tempo real';        color=[System.Drawing.Color]::FromArgb(99,102,241) }
  @{ name='Lucro e ROI calculados';     color=[System.Drawing.Color]::FromArgb(45,212,167) }
  @{ name='Calculadora de surebet';     color=[System.Drawing.Color]::FromArgb(244,63,94) }
  @{ name='Metas e relat$([char]0x00F3)rios';    color=[System.Drawing.Color]::FromArgb(245,158,11) }
  @{ name='Sync celular + PC';          color=[System.Drawing.Color]::FromArgb(124,92,255) }
)
$cardX = 90; $cardW = $s.w - 180; $cardH = 86; $cardR = 18; $cardGap = 16
$startY = 410
for($i=0;$i -lt $features.Count;$i++){
  $y = $startY + $i*($cardH + $cardGap)
  $path = Get-RoundedPath $cardX $y $cardW $cardH $cardR
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(80,30,40,80))
  $g.FillPath($bg, $path); $bg.Dispose()
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80,124,140,255)), 1.5
  $g.DrawPath($pen, $path); $pen.Dispose(); $path.Dispose()
  $dotBr = New-Object System.Drawing.SolidBrush $features[$i].color
  $g.FillEllipse($dotBr, $cardX + 24, $y + $cardH/2 - 9, 18, 18)
  $dotBr.Dispose()
  $font = New-Object System.Drawing.Font('Segoe UI', 22, [System.Drawing.FontStyle]::Bold)
  $textBr = New-Object System.Drawing.SolidBrush $white
  $sz = $g.MeasureString($features[$i].name, $font)
  $textY = $y + ($cardH - $sz.Height) / 2
  $g.DrawString($features[$i].name, $font, $textBr, $cardX + 64, $textY)
  $font.Dispose(); $textBr.Dispose()
}
Save-Slide $s "C:\Users\loamy\Downloads\apostack-slide-3.png"
"Slide 3 ok"

# ============= SLIDE 5 — CTA =============
$s = New-Slide
$g = $s.g
$white = [System.Drawing.Color]::White
# Triangle A logo at top
$triPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$cx = $s.w/2; $triTop = 180; $triH = 130
$pts = @(
  [System.Drawing.PointF]::new($cx, $triTop)
  [System.Drawing.PointF]::new($cx + 80, $triTop + $triH)
  [System.Drawing.PointF]::new($cx + 40, $triTop + $triH)
  [System.Drawing.PointF]::new($cx + 20, $triTop + $triH - 40)
  [System.Drawing.PointF]::new($cx - 20, $triTop + $triH - 40)
  [System.Drawing.PointF]::new($cx - 40, $triTop + $triH)
  [System.Drawing.PointF]::new($cx - 80, $triTop + $triH)
)
$triPath.AddPolygon($pts)
$triRect = New-Object System.Drawing.RectangleF ($cx - 90), $triTop, 180, $triH
$triBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($triRect, [System.Drawing.Color]::FromArgb(109,120,255), [System.Drawing.Color]::FromArgb(154,92,255), [single]135)
$g.FillPath($triBrush, $triPath)
$triBrush.Dispose(); $triPath.Dispose()
# Headline
Draw-Centered $s "TESTE 7 DIAS" 380 96 $true $white
Draw-Centered $s "GR$([char]0x00C1)TIS" 480 96 $true ([System.Drawing.Color]::FromArgb(160,130,255))
Draw-Centered $s "Sem cart$([char]0x00E3)o pra come$([char]0x00E7)ar" 620 26 $false ([System.Drawing.Color]::FromArgb(180,174,184,214))
# Big purple button
$btnFont = New-Object System.Drawing.Font('Segoe UI', 32, [System.Drawing.FontStyle]::Bold)
$btnText = "apostack.com"
$btnSz = $g.MeasureString($btnText, $btnFont)
$btnPadX = 56; $btnPadY = 18
$btnW = $btnSz.Width + $btnPadX*2; $btnH = $btnSz.Height + $btnPadY*2
$btnX = ($s.w - $btnW) / 2; $btnY = 750
$btnR = $btnH / 2
$btnPath = Get-RoundedPath $btnX $btnY $btnW $btnH $btnR
$btnRect = New-Object System.Drawing.RectangleF $btnX, $btnY, $btnW, $btnH
$btnBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($btnRect, [System.Drawing.Color]::FromArgb(109,120,255), [System.Drawing.Color]::FromArgb(154,92,255), [single]0)
$g.FillPath($btnBrush, $btnPath); $btnBrush.Dispose()
$btnTextBr = New-Object System.Drawing.SolidBrush $white
$g.DrawString($btnText, $btnFont, $btnTextBr, $btnX + $btnPadX, $btnY + $btnPadY)
$btnTextBr.Dispose(); $btnFont.Dispose(); $btnPath.Dispose()
# Trust bullets at bottom
$small = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Regular)
$smallBr = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(160,174,184,214))
$trustText = "Cancele quando quiser  $([char]0x00B7)  Sync mobile+PC  $([char]0x00B7)  Suporte humano"
$trustSz = $g.MeasureString($trustText, $small)
$g.DrawString($trustText, $small, $smallBr, ($s.w - $trustSz.Width)/2, 940)
$small.Dispose(); $smallBr.Dispose()
Save-Slide $s "C:\Users\loamy\Downloads\apostack-slide-5.png"
"Slide 5 ok"
