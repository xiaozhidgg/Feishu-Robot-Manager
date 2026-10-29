@echo off
chcp 936 >nul
title 飞书 DeepSeek 机器人
cd /d "%~dp0"

echo ==========================================
echo   飞书 DeepSeek 机器人
echo ==========================================
echo 工作目录: %CD%
echo.

if not exist "index.js" goto :no_index

where node >nul 2>&1
if errorlevel 1 goto :no_node

if /i "%~1"=="--check" goto :check

if exist ".env" goto :env_ready
echo [提示] 未找到 .env，正在从 .env.example 复制...
copy /y ".env.example" ".env" >nul

:env_ready
findstr /c:"cli_xxxxxxxx" ".env" >nul 2>&1
if errorlevel 1 goto :deps
echo [需要配置] .env 里还是占位符 cli_xxxxxxxx。
echo            请填写 FEISHU_APP_ID / FEISHU_APP_SECRET / DEEPSEEK_API_KEY。
echo            保存并关闭记事本后，回到本窗口按任意键继续。
echo.
notepad ".env"
pause >nul

:deps
if exist "node_modules" goto :run
echo [安装] 正在安装依赖，首次约 1-2 分钟...
call npm install --no-audit --no-fund
if errorlevel 1 goto :npm_fail
echo [完成] 依赖安装成功。
echo.

:run
echo [启动] 正在启动机器人。看到「机器人已启动」即成功，按 Ctrl+C 可停止。
echo.
node index.js
goto :end

:check
for /f "delims=" %%v in ('node -v') do echo Node 版本 : %%v
if exist ".env" (echo .env      : 已存在) else (echo .env      : 缺失，启动时会自动创建)
if exist "node_modules" (echo 依赖      : 已安装) else (echo 依赖      : 未安装，启动时会自动安装)
findstr /c:"cli_xxxxxxxx" ".env" >nul 2>&1
if errorlevel 1 (echo 凭证      : 已填写) else (echo 凭证      : 仍是占位符，需要填写)
echo.
echo 环境自检完成。
exit /b 0

:no_index
echo [错误] 当前目录没有 index.js。
echo        请把本文件放在 feishu-deepseek-bot 文件夹里，
echo        或改用上级目录的 启动飞书机器人.bat。
goto :end

:no_node
echo [错误] 没检测到 Node.js，请先安装 Node 18 或更高版本：https://nodejs.org
goto :end

:npm_fail
echo [错误] 依赖安装失败，请检查网络或 npm 源。

:end
echo.
pause
