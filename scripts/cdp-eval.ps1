# CDP / Node inspector 求值辅助脚本（测试用）
# 用法：.\cdp-eval.ps1 -Port 9230 -Expression '...' [-AwaitPromise]
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Expression,
    [switch]$AwaitPromise,
    [int]$Index = 0
)
$ErrorActionPreference = 'Stop'
$json = curl.exe -s "http://127.0.0.1:$Port/json/list"
$target = $json | ConvertFrom-Json
$t = if ($target -is [array]) { $target[$Index] } else { $target }
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$t.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).Wait()
$params = @{ expression = $Expression; returnByValue = $true }
if ($AwaitPromise) { $params.awaitPromise = $true }
$msg = @{ id = 1; method = 'Runtime.evaluate'; params = $params } | ConvertTo-Json -Compress -Depth 6
$bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
$ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
$buf = New-Object byte[] 2097152
$ms = New-Object System.IO.MemoryStream
$deadline = (Get-Date).AddSeconds(20)
do {
    $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [System.Threading.CancellationToken]::None)
    $r.Wait()
    $ms.Write($buf, 0, $r.Result.Count)
} while (-not $r.Result.EndOfMessage -and (Get-Date) -lt $deadline)
$ws.Dispose()
$resp = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
$obj = $resp | ConvertFrom-Json
if ($obj.result.result.value -ne $null) {
    Write-Output $obj.result.result.value
} elseif ($obj.result.exceptionDetails) {
    Write-Output ("ERROR: " + $obj.result.exceptionDetails.text + " " + $obj.result.exceptionDetails.exception.description)
    exit 1
} else {
    Write-Output $resp
}
