# 向页面发送 Ctrl+L 组合键（测试用）：触发「连接远程服务」弹窗
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$Index = 0
)
$ErrorActionPreference = 'Stop'
$json = curl.exe -s "http://127.0.0.1:$Port/json/list"
$target = $json | ConvertFrom-Json
$t = if ($target -is [array]) { $target[$Index] } else { $target }
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$t.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).Wait()
function Send-Cdp($method, $params) {
    $msg = @{ id = 1; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 6
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
    $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait() | Out-Null
    $buf = New-Object byte[] 65536
    $ms = New-Object System.IO.MemoryStream
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [System.Threading.CancellationToken]::None)
        $r.Wait()
        $ms.Write($buf, 0, $r.Result.Count)
    } while (-not $r.Result.EndOfMessage -and (Get-Date) -lt $deadline)
    [System.Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json | Out-Null
}
Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'l'; code = 'KeyL'; windowsVirtualKeyCode = 76; modifiers = 2 }
Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'l'; code = 'KeyL'; windowsVirtualKeyCode = 76; modifiers = 2 }
$ws.Dispose()
"sent Ctrl+L"
