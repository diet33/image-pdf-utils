# GitHub Pages 배포 스크립트
# 사용법: PowerShell에서 .\deploy.ps1 실행

$ErrorActionPreference = "Stop"
$Git = "C:\Program Files\Git\cmd\git.exe"
$Gh  = "C:\Program Files\GitHub CLI\gh.exe"
$Root = $PSScriptRoot

Set-Location $Root

# GitHub 로그인 확인
& $Gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "GitHub 로그인이 필요합니다." -ForegroundColor Yellow
    & $Gh auth login --hostname github.com --git-protocol https --web
}

# 저장소 이름 (변경 가능)
$RepoName = "image-pdf-utils"

# 원격 저장소 없으면 생성
$remote = & $Git remote get-url origin 2>$null
if (-not $remote) {
    Write-Host "GitHub 저장소 생성: $RepoName" -ForegroundColor Cyan
    & $Gh repo create $RepoName --public --source=. --remote=origin --push
} else {
    & $Git branch -M main
    & $Git push -u origin main
}

# GitHub Pages (Actions) 활성화 안내
$user = (& $Gh api user -q .login)
$url  = "https://$user.github.io/$RepoName/"
Write-Host ""
Write-Host "배포 완료!" -ForegroundColor Green
Write-Host "사이트 URL: $url" -ForegroundColor Green
Write-Host "Settings > Pages > Source: GitHub Actions 확인" -ForegroundColor Yellow
Write-Host "Actions 탭에서 Deploy workflow 완료까지 1~3분 대기" -ForegroundColor Yellow