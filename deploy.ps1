# GitHub Pages deploy script
# Run: deploy.bat  OR  powershell -ExecutionPolicy Bypass -File .\deploy.ps1

$ErrorActionPreference = "Stop"
$Git = "C:\Program Files\Git\cmd\git.exe"
$Gh  = "C:\Program Files\GitHub CLI\gh.exe"
$Root = $PSScriptRoot

Set-Location $Root

$authOk = $false
$oldEap = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
& $Gh auth status *> $null
if ($LASTEXITCODE -eq 0) { $authOk = $true }
$ErrorActionPreference = $oldEap

if (-not $authOk) {
    Write-Host "[!] GitHub login required. Browser will open." -ForegroundColor Yellow
    Write-Host "    Complete login at https://github.com/login/device if needed." -ForegroundColor Yellow
    & $Gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] GitHub login failed. Please run again." -ForegroundColor Red
        exit 1
    }
}

$RepoName = "image-pdf-utils"

$remote = ""
$ErrorActionPreference = "SilentlyContinue"
$remote = & $Git remote get-url origin 2>$null
$ErrorActionPreference = $oldEap

if (-not $remote) {
    Write-Host "[*] Creating repo: $RepoName" -ForegroundColor Cyan
    & $Gh repo create $RepoName --public --source=. --remote=origin --push
} else {
    & $Git branch -M main
    & $Git push -u origin main
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] Push failed. Check errors above." -ForegroundColor Red
    exit 1
}

$user = (& $Gh api user -q .login)
$url  = "https://$user.github.io/$RepoName/"

Write-Host ""
Write-Host "[OK] Deploy pushed!" -ForegroundColor Green
Write-Host "Site URL: $url" -ForegroundColor Green
Write-Host "Check: Settings > Pages > Source = GitHub Actions" -ForegroundColor Yellow
Write-Host "Wait 1-3 min for Actions workflow to finish." -ForegroundColor Yellow