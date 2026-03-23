# 微信 Bot 一键启动脚本
# 需要以管理员身份运行

$wechatExe = "D:\vx3.9\WeChat\WeChat.exe"
$botDir    = "D:\Weixin\bot"
$python    = "$botDir\venv\Scripts\python.exe"
$botScript = "$botDir\bot.py"

# 1. 启动微信（如果未运行）
$wechatProc = Get-Process -Name "WeChat" -ErrorAction SilentlyContinue
if (-not $wechatProc) {
    Write-Host "正在启动微信 3.9.12.51..." -ForegroundColor Cyan
    Start-Process $wechatExe
    Write-Host "等待微信登录（30秒）..." -ForegroundColor Yellow
    Start-Sleep -Seconds 30
} else {
    Write-Host "微信已在运行 (PID: $($wechatProc.Id))" -ForegroundColor Green
}

# 2. 启动 Bot
Write-Host "正在启动 Bot..." -ForegroundColor Cyan
Set-Location $botDir
& $python $botScript
