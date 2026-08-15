# CDP 页面截图（测试用）：把指定 target 渲染输出存为 PNG
# 用法：.\cdp-shot.ps1 -Port 9230 -Index 1 -Out shot.png
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Index = 0
)
$ErrorActionPreference = 'Stop'
$json = curl.exe -s "http://127.0.0.1:$Port/json/list"
$target = $json | ConvertFrom-Json
$t = if ($target -is [array]) { $target[$Index] } else { $target }
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$t.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).Wait()
$msg = @{ id = 1; method = 'Page.captureScreenshot'; params = @{ format = 'png' } } | ConvertTo-Json -Compress -Depth 6
$bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
$ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
$buf = New-Object byte[] 8388608
$ms = New-Object System.IO.MemoryStream
$deadline = (Get-Date).AddSeconds(30)
do {
    $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [System.Threading.CancellationToken]::None)
    $r.Wait()
    $ms.Write($buf, 0, $r.Result.Count)
} while (-not $r.Result.EndOfMessage -and (Get-Date) -lt $deadline)
$ws.Dispose()
$resp = [System.Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
if ($resp.result.data) {
    [IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($resp.result.data))
    Write-Output ("saved: " + $Out)
} else {
    Write-Output $resp
    exit 1
}
