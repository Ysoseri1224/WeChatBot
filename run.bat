@echo off
cd /d D:\Weixin\bot
:loop
echo [%date% %time%] Starting WeChatBot...
D:\Weixin\bot\venv\Scripts\python.exe bot.py
echo [%date% %time%] Bot exited. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
