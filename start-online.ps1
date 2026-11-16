# 极简台球 · 一键启动联机
# 双击「启动联机.bat」即可运行本脚本
$ErrorActionPreference = "Continue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

Write-Host ""
Write-Host "  🎱 极简台球 · 联机启动" -ForegroundColor Cyan
Write-Host "  -----------------------------" -ForegroundColor DarkGray
Write-Host ""

# ---------- 1. 找 node ----------
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $node = $c; break } }
}
if (-not $node) {
  Write-Host "  ✗ 找不到 Node.js，请先安装：https://nodejs.org" -ForegroundColor Red
  Read-Host "  按回车退出"
  exit 1
}

# ---------- 2. 如果已经在运行，直接打开现有地址 ----------
$addrFile = Join-Path $dir "当前地址.txt"
$existing = ""
if (Test-Path $addrFile) { $existing = (Get-Content $addrFile -Raw).Trim() }
if ($existing) {
  try {
    $r = Invoke-WebRequest -Uri $existing -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) {
      Write-Host "  已经在运行，直接打开：" -ForegroundColor Green
      Write-Host "  $existing" -ForegroundColor Cyan
      try { Set-Clipboard -Value $existing } catch {}
      Start-Process $existing
      Start-Sleep -Seconds 2
      exit 0
    }
  } catch {}
}

# ---------- 3. 启动游戏服务器 ----------
$running = $false
try {
  $conn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
  if ($conn) { $running = $true }
} catch {}
if ($running) {
  Write-Host "  [1/2] 游戏服务器已经在运行（8080）" -ForegroundColor Yellow
} else {
  Start-Process -FilePath $node -ArgumentList "pool-server.js" -WorkingDirectory $dir -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Host "  [1/2] 游戏服务器已启动（8080）" -ForegroundColor Green
}

# ---------- 4. 启动公网隧道 ----------
$cf = Join-Path $dir "tools\cloudflared.exe"
if (-not (Test-Path $cf)) {
  Write-Host "  ✗ 找不到 tools\cloudflared.exe" -ForegroundColor Red
  Read-Host "  按回车退出"
  exit 1
}
# 清掉可能残留的旧隧道（只杀台球自己那条 8080 的，别误杀别的程序用的 cloudflared）
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'localhost:8080|127\.0\.0\.1:8080' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
$log = Join-Path $dir "tunnel.log"
Remove-Item $log -Force -ErrorAction SilentlyContinue
$tun = Start-Process -FilePath $cf -ArgumentList @("tunnel", "--url", "http://localhost:8080", "--no-autoupdate", "--protocol", "http2") `
  -RedirectStandardError $log -RedirectStandardOutput "$log.out" -WindowStyle Hidden -PassThru
# 记下隧道 PID：服务器闲置自动关闭时会把它一起关掉
if ($tun) { $tun.Id | Out-File -FilePath (Join-Path $dir "tunnel.pid") -Encoding ascii -NoNewline }
Write-Host "  [2/2] 正在建立公网隧道…" -ForegroundColor Green

$url = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}

# 等它真的能打开再报地址（新域名解析可能要几十秒）
if ($url) {
  try { ipconfig /flushdns | Out-Null } catch {}
  Write-Host "      等待域名生效…" -ForegroundColor DarkGray
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) { Write-Host "      警告：暂时还连不上，可能再过一会儿才生效" -ForegroundColor Yellow }
}

Write-Host ""
if ($url) {
  try { Set-Clipboard -Value $url } catch {}
  $url | Out-File -FilePath (Join-Path $dir "当前地址.txt") -Encoding utf8
  Write-Host "  联机地址（已复制到剪贴板）" -ForegroundColor Cyan
  Write-Host "  $url" -ForegroundColor Green
  Write-Host ""
  Write-Host "  把链接发给朋友 → 两边打开 → 联机 → 创建/加入房间" -ForegroundColor Gray
  Start-Process $url
} else {
  Write-Host "  ✗ 隧道建立失败，检查网络后重试（日志：tunnel.log）" -ForegroundColor Red
}
Write-Host ""
Read-Host "  按回车关闭本窗口（服务器和隧道会继续在后台运行）"
