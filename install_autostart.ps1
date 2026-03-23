# 注册开机自启任务（需要管理员身份运行一次）

schtasks /delete /tn WeChatBot /f 2>$null

schtasks /create /tn WeChatBot /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File D:\Weixin\bot\start_bot.ps1" /sc onlogon /rl highest /f

if ($LASTEXITCODE -eq 0) {
    Write-Host "开机自启任务已注册：WeChatBot"
} else {
    Write-Host "注册失败，请以管理员身份运行"
}
