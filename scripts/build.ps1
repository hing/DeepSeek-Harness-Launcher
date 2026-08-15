# DSHL 一键构建脚本
#
# 步骤：
#   1. 下载便携版 Node.js（nodejs.org 官方 zip）到 build\node\
#   2. npm 安装 @deepseek-ai/dsh 依赖闭包（含前端 dist）到 build\dsh\
#   3. 安装 Electron 构建依赖并 electron-builder 打包 Windows 产物
#
# 用法：  powershell -ExecutionPolicy Bypass -File scripts\build.ps1 [-NodeVersion v24.19.0] [-SkipNode] [-SkipDsh] [-SkipPack] [-SkipGreen]
param(
    [string]$NodeVersion = 'v24.19.0',
    [switch]$SkipNode,
    [switch]$SkipDsh,
    [switch]$SkipPack,
    [switch]$SkipGreen
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
$nodeDir = Join-Path $build 'node'
$dshDir = Join-Path $build 'dsh'
$appDir = Join-Path $root 'app'

# 确保 build 目录存在（CI 全新 checkout 时 build\ 不在仓库中）
New-Item -ItemType Directory -Force -Path $build | Out-Null

Write-Host "=== DSHL 构建开始（Node $NodeVersion）===" -ForegroundColor Cyan

# ---- 1. 便携版 Node ----
if (-not $SkipNode) {
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if (Test-Path $nodeExe) {
        Write-Host "[1/3] 已存在 $nodeDir，跳过下载" -ForegroundColor Yellow
    } else {
        Write-Host "[1/3] 下载便携版 Node.js $NodeVersion ..."
        $zip = Join-Path $build "node-$NodeVersion-win-x64.zip"
        $urls = @(
            "https://npmmirror.com/mirrors/node/$NodeVersion/node-$NodeVersion-win-x64.zip",
            "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
        )
        $downloaded = $false
        foreach ($url in $urls) {
            Write-Host "    尝试 $url"
            curl.exe -L --fail --connect-timeout 20 -o $zip $url
            if ($LASTEXITCODE -eq 0 -and (Test-Path $zip)) { $downloaded = $true; break }
            Remove-Item $zip -ErrorAction SilentlyContinue
        }
        if (-not $downloaded) { throw 'Node.js 下载失败，请检查网络后重试' }
        $tmp = Join-Path $build 'node-tmp'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        Move-Item (Join-Path $tmp "node-$NodeVersion-win-x64") $nodeDir
        Remove-Item $zip, $tmp -Recurse -Force
        Write-Host "    -> $nodeDir"
    }
    & (Join-Path $nodeDir 'node.exe') --version
}

# ---- 2. dsh 依赖闭包 ----
if (-not $SkipDsh) {
    Write-Host "[2/3] npm 安装 @deepseek-ai/dsh 闭包（含前端 dist）..."
    New-Item -ItemType Directory -Force -Path $dshDir | Out-Null
    Push-Location $dshDir
    try {
        # 与官方 `npx @deepseek-ai/dsh` 完全对齐（含 devDependencies），避免漏装运行闭包
        & npm.cmd install @deepseek-ai/dsh --no-audit --no-fund --loglevel=warn
        if ($LASTEXITCODE -ne 0) { throw 'npm install @deepseek-ai/dsh 失败' }
        # npm 11 的 allow-scripts 安全机制会拦 install 脚本，导致 koffi / node-pty /
        # dsh-subprocess-local 的原生预编译二进制缺失；批准并重建它们
        & npm.cmd approve-scripts --all 2>$null
        & npm.cmd rebuild koffi node-pty @deepseek-ai/dsh-subprocess-local protobufjs @google/genai --no-audit --no-fund 2>$null
        $bin = Join-Path $dshDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        $dist = Join-Path $dshDir 'node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html'
        if (-not (Test-Path $bin)) { throw "闭包缺少 CLI 入口：$bin" }
        if (-not (Test-Path $dist)) { throw "闭包缺少前端 dist：$dist" }
        Write-Host "    CLI 入口与前端 dist 就位 ✓"
    } finally {
        Pop-Location
    }
}

# ---- 3. 图标 ----
& (Join-Path $root 'scripts\gen-icon.ps1')

# ---- 4. Electron 打包 ----
if (-not $SkipPack) {
    Write-Host "[3/3] 安装 Electron 构建依赖并打包..."
    # 国内网络：GitHub 直连不可达时走 npmmirror 镜像（可自行移除）
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    Push-Location $appDir
    try {
        & npm.cmd install --no-audit --no-fund --loglevel=warn
        if ($LASTEXITCODE -ne 0) { throw 'npm install（Electron）失败' }
        # 收集器补丁：本机安全软件导致 powershell.exe 5.1 在 stdout 重定向时退出崩溃
        # （0xC0000005）；收集器在 Windows 上用 powershell 包装 npm list，改用 pwsh.exe
        $collector = Join-Path $appDir 'node_modules\app-builder-lib\out\node-module-collector\nodeModulesCollector.js'
        if (Test-Path $collector) {
            $content = Get-Content $collector -Raw
            if ($content -match '\["powershell\.exe"') {
                $content = $content -replace '\["powershell\.exe"', '["pwsh.exe"'
                [System.IO.File]::WriteAllText($collector, $content)
                Write-Host '    已打收集器补丁：powershell.exe -> pwsh.exe'
            }
        }
        & npx.cmd electron-builder --win
        if ($LASTEXITCODE -ne 0) { throw 'electron-builder 打包失败' }
    } finally {
        Pop-Location
    }
    # 绿色版自解压 exe（stub + zip 载荷，解压到 exe 所在目录）；-SkipGreen 跳过
    if (-not $SkipGreen) {
        # 版本号与 app\package.json 保持一致，避免绿色版文件名版本错位
        $pkg = Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json
        & (Join-Path $root 'scripts\build-green.ps1') -Version $pkg.version
        if ($LASTEXITCODE -ne 0) { throw '绿色版构建失败' }
    }
}

Write-Host "=== 构建完成，产物位于 build\dist\ ===" -ForegroundColor Green
