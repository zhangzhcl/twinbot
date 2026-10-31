Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Clear transparent
$g.Clear([System.Drawing.Color]::Transparent)

# Background rounded rectangle
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 50
$rect = New-Object System.Drawing.Rectangle(10, 10, 236, 236)
$d = $r * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

# Background gradient (clean neutral obsidian)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(10, 10)),
    (New-Object System.Drawing.PointF(246, 246)),
    [System.Drawing.Color]::FromArgb(255, 30, 30, 30),
    [System.Drawing.Color]::FromArgb(255, 18, 18, 18)
)
$g.FillPath($bgBrush, $path)

# Subtle elegant border
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 70, 70, 70), 2.5)
$g.DrawPath($borderPen, $path)

# TwinBot Monogram "T" in pure crisp white / ivory (Pionle style)
$accentColor = [System.Drawing.Color]::FromArgb(255, 240, 240, 240)
$accentBrush = New-Object System.Drawing.SolidBrush($accentColor)
$subtleColor = [System.Drawing.Color]::FromArgb(220, 140, 140, 140)
$subtleBrush = New-Object System.Drawing.SolidBrush($subtleColor)

# Top horizontal bar of T
$topBar = New-Object System.Drawing.Rectangle(62, 66, 132, 24)
$topBarPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$tr = 9
$td = $tr * 2
$topBarPath.AddArc($topBar.X, $topBar.Y, $td, $td, 180, 90)
$topBarPath.AddArc($topBar.Right - $td, $topBar.Y, $td, $td, 270, 90)
$topBarPath.AddArc($topBar.Right - $td, $topBar.Bottom - $td, $td, $td, 0, 90)
$topBarPath.AddArc($topBar.X, $topBar.Bottom - $td, $td, $td, 90, 90)
$topBarPath.CloseFigure()
$g.FillPath($accentBrush, $topBarPath)

# Vertical stem of T
$stem = New-Object System.Drawing.Rectangle(116, 90, 24, 98)
$stemPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$sr = 8
$sd = $sr * 2
$stemPath.AddArc($stem.X, $stem.Y, $sd, $sd, 180, 90)
$stemPath.AddArc($stem.Right - $sd, $stem.Y, $sd, $sd, 270, 90)
$stemPath.AddArc($stem.Right - $sd, $stem.Bottom - $sd, $sd, $sd, 0, 90)
$stemPath.AddArc($stem.X, $stem.Bottom - $sd, $sd, $sd, 90, 90)
$stemPath.CloseFigure()
$g.FillPath($accentBrush, $stemPath)

# Twin Orbit Nodes (Left and Right glowing dots representing Twin agents)
$leftNode = New-Object System.Drawing.Rectangle(66, 122, 22, 22)
$rightNode = New-Object System.Drawing.Rectangle(168, 122, 22, 22)
$g.FillEllipse($subtleBrush, $leftNode)
$g.FillEllipse($subtleBrush, $rightNode)

# Clean up graphics
$g.Dispose()

# Ensure directories exist
$targetDirs = @(
    "D:\DevWork\TwinBot\apps\desktop\resources",
    "D:\DevWork\TwinBot\apps\desktop\static",
    "D:\DevWork\TwinBot\apps\desktop\dist\static"
)
foreach ($dir in $targetDirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
}

# Save PNGs
$bmp.Save("D:\DevWork\TwinBot\apps\desktop\resources\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save("D:\DevWork\TwinBot\apps\desktop\static\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save("D:\DevWork\TwinBot\apps\desktop\dist\static\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)

# Save ICO
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = New-Object System.IO.FileStream("D:\DevWork\TwinBot\apps\desktop\resources\icon.ico", [System.IO.FileMode]::Create)
$icon.Save($fs)
$fs.Close()
$icon.Dispose()
$bmp.Dispose()

Write-Output "TwinBot Icon successfully created."
