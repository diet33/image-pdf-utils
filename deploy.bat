@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo  GitHub Pages 배포
echo ========================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
pause