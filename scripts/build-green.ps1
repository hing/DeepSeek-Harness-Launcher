# 构建绿色版自解压 exe：
#   [stub exe] + [win-unpacked zip 载荷] + [8 字节小端载荷长度]
# 产物：build\dist\DSHL-0.1.0-green.exe
param(
    [string]$Version = '0.1.0'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'app'
$dist = Join-Path $root 'build\dist'
$zip = Join-Path $dist "DSHL-$Version-win.zip"
$stubSrc = Join-Path $root 'scripts\green-stub.cs'
$stubExe = Join-Path $dist 'green-stub.tmp.exe'
$out = Join-Path $dist "DSHL-$Version-green.exe"
$icon = Join-Path $appDir 'build\icon.ico'

if (-not (Test-Path $zip)) { throw "未找到 zip 载荷：$zip（先运行 electron-builder 生成 zip 目标）" }

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "未找到 csc.exe：$csc" }

Write-Host "[green] 编译自解压 stub ..."
& $csc /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ /win32icon:$icon /out:$stubExe `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll $stubSrc
if ($LASTEXITCODE -ne 0) { throw 'stub 编译失败' }

Write-Host "[green] 拼接载荷（zip = $(([math]::Round((Get-Item $zip).Length/1MB,1))) MB）..."
$payload = [System.IO.File]::ReadAllBytes($zip)
$lenBytes = [System.BitConverter]::GetBytes([long]$payload.Length)
$fs = [System.IO.File]::Create($out)
try {
    $stub = [System.IO.File]::ReadAllBytes($stubExe)
    $fs.Write($stub, 0, $stub.Length)
    $fs.Write($payload, 0, $payload.Length)
    $fs.Write($lenBytes, 0, $lenBytes.Length)
} finally {
    $fs.Dispose()
}
Remove-Item $stubExe -Force -ErrorAction SilentlyContinue
Write-Host "[green] 完成：$out（$([math]::Round((Get-Item $out).Length/1MB,1)) MB）"
