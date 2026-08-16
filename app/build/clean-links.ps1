# DSHL 移动目录辅助脚本
#
# 作用：删除 .dsh\profiles\node_modules 受管链接树（不含任何用户数据，下次启动自动重建），
#       以便安全地跨盘移动整个程序目录。
#
# 为什么需要：跨盘移动/复制目录时，Windows 资源管理器会跟随该链接树（junction）
#       反复复制 resources\dsh 的内容，导致进度条卡死。
#
# 用法：
#   1) 双击 clean-links.bat；或
#   2) 右键本文件 →「使用 PowerShell 运行」；或
#   3) 命令行：powershell -ExecutionPolicy Bypass -File clean-links.ps1
#
# 移动完成后：首次启动启动器会自动重建全部链接。

$ErrorActionPreference = 'Stop'

# 脚本位于程序目录根（与 DSHL.exe 同级）
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$linkTree = Join-Path $root '.dsh\profiles\node_modules'

if (-not (Test-Path $linkTree)) {
    Write-Host "未找到受管链接树：$linkTree" -ForegroundColor Yellow
    Write-Host "（可能尚未启动过，或已清理；无需操作）" -ForegroundColor Yellow
    Write-Host "现在可以安全移动程序目录。" -ForegroundColor Green
    exit 0
}

$entryCount = (Get-ChildItem $linkTree -Force | Measure-Object).Count
Remove-Item $linkTree -Recurse -Force

if (-not (Test-Path $linkTree)) {
    Write-Host "已删除受管链接树（$entryCount 个条目）。" -ForegroundColor Green
    Write-Host "现在可以安全移动程序目录（含跨盘移动）。" -ForegroundColor Green
    Write-Host "移动后首次启动，启动器会自动重建全部链接。" -ForegroundColor Green
} else {
    Write-Host "删除失败，请关闭程序后重试，或检查是否被杀毒软件拦截。" -ForegroundColor Red
    exit 1
}
