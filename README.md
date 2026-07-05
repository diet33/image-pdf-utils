# 올인원 이미지/PDF 유틸리티

설치 없이 브라우저에서 바로 사용할 수 있는 이미지·PDF 변환 도구입니다.  
모든 처리는 **사용자의 브라우저에서 로컬로** 수행되며, 파일이 서버로 전송되지 않습니다.

## 프로그램 소개

GitHub Pages에 올려 정적 웹앱으로 실행할 수 있는 올인원 유틸리티입니다.  
PDF 변환, 이미지 축소·확대, 세로 합치기, 문서 스캔 보정 기능을 하나의 페이지에서 제공합니다.

## 주요 기능

| 기능 | 설명 |
|------|------|
| **PDF → JPG** | PDF 각 페이지를 JPG로 변환, 개별·ZIP 다운로드 |
| **이미지 줄이기** | JPG/PNG/WEBP를 50%/20%/10% 비율로 축소 (일괄 처리) |
| **이미지 2배 확대** | pica 기반 고품질 2배 업스케일 |
| **이미지 세로 합치기** | 여러 이미지를 위→아래로 이어붙이기 |
| **문서 스캔 보정** | OpenCV.js로 문서 영역 감지, 기울기 보정, 선명도·대비 향상 |
| **사진 보기** | iPhone 파일 앱 사진을 불러와 썸네일·슬라이드로 넘겨 보기 |

## 테스트 실행

```bash
# 로컬 서버 (8081) 실행 후
python tests/test_runner.py
```

Playwright로 5개 기능(이미지 줄이기, 2배 확대, 세로 합치기, PDF→JPG, 문서 스캔)을 자동 검증합니다.

## GitHub Pages 배포 방법

### 원클릭 배포 (Windows)

```cmd
cd D:\GROK_BUILD
deploy.bat
```

또는 PowerShell 실행 정책 오류 시:

```powershell
Set-Location "D:\GROK_BUILD"
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

최초 실행 시 브라우저에서 GitHub 로그인이 필요합니다.

### 1. 저장소 생성 및 업로드

1. GitHub에서 새 저장소를 만듭니다 (예: `image-pdf-utils`).
2. 아래 파일을 저장소 루트에 업로드합니다.
   - `index.html`
   - `style.css`
   - `app.js`
   - `README.md`

### 2. GitHub Pages 활성화

#### 방법 A: GitHub Actions (권장)

이 저장소에는 `.github/workflows/deploy.yml` 이 포함되어 있습니다.

1. 저장소 **Settings** → **Pages** 로 이동합니다.
2. **Source** 를 `GitHub Actions` 로 선택합니다.
3. `main` 브랜치에 push하면 자동으로 배포됩니다.

```bash
git add .
git commit -m "Deploy image/pdf utility"
git push origin main
```

#### 방법 B: 브랜치 직접 배포

1. 저장소 **Settings** → **Pages** 로 이동합니다.
2. **Source** 를 `Deploy from a branch` 로 선택합니다.
3. **Branch** 를 `main` (또는 `master`), 폴더는 `/ (root)` 로 설정합니다.
4. **Save** 를 클릭합니다.

### 3. 접속

몇 분 후 아래 주소로 접속할 수 있습니다.

```
https://<사용자명>.github.io/<저장소명>/
```

### 로컬에서 테스트

Python이 설치되어 있다면 프로젝트 폴더에서:

```bash
# Python 3
python -m http.server 8080
```

브라우저에서 `http://localhost:8080` 으로 접속합니다.

> `file://` 로 직접 열면 일부 CDN·Web Worker 동작이 제한될 수 있으므로 로컬 서버 사용을 권장합니다.

## iPhone에서 사용하기

1. **Safari**로 사이트에 접속하세요. (Chrome도 가능하지만 Safari 권장)
   - GitHub Pages에 배포한 URL을 사용하거나
   - 같은 Wi-Fi에서 PC IP로 접속: `http://<PC_IP>:8081` (PC에서 `python -m http.server 8081` 실행)
2. 상단 **공유** 버튼 → **홈 화면에 추가**로 앱처럼 설치할 수 있습니다.
3. 파일 선택은 **탭**으로 진행합니다. (iPhone은 드래그 앤 드롭 미지원)
4. **문서 스캔** 탭에서는 **카메라로 촬영** 또는 **앨범에서 선택** 버튼을 사용하세요.
5. 결과 저장:
   - **저장 / 공유** 버튼 → 공유 시트에서 「사진 저장」 또는 「파일에 저장」
   - 또는 이미지를 **길게 눌러** 「사진 저장」
6. iPhone은 메모리 한도 때문에 **작은 파일**을 권장합니다.
   - PDF: 20MB 이하
   - 이미지: 15MB 이하
   - ZIP보다 **개별 이미지 저장**이 더 안정적입니다.

## 사용 방법

### PDF → JPG

1. **PDF → JPG** 탭을 선택합니다.
2. PDF 파일을 드래그하거나 클릭하여 선택합니다.
3. JPG 품질을 선택합니다.
4. **변환 실행** 버튼을 누릅니다.
5. 결과 카드에서 개별 다운로드하거나 **전체 ZIP 다운로드**를 사용합니다.

### 이미지 줄이기

1. **이미지 줄이기** 탭에서 이미지(여러 장 가능)를 업로드합니다.
2. 50% / 20% / 10% 중 축소 비율을 선택합니다.
3. **변환 실행** 후 미리보기에서 확인하고 다운로드합니다.

### 이미지 2배 확대

1. **이미지 2배 확대** 탭에서 이미지 1장을 업로드합니다.
2. 출력 형식(JPG/PNG/WEBP)을 선택합니다.
3. **2배 확대 실행** 후 결과를 다운로드합니다.

### 이미지 세로 합치기

1. **이미지 세로 합치기** 탭에서 2장 이상 업로드합니다.
2. 기준 폭(첫 번째 / 가장 넓은 / 직접 입력)과 출력 형식을 선택합니다.
3. **합치기 실행** 후 결과를 다운로드합니다.

### 사진 보기 (iPhone 파일 앱)

1. **사진 보기** 탭을 선택합니다.
2. **파일 앱에서 사진 선택** → iPhone 파일 앱에서 폴더 열기 → **선택** → 여러 장 선택
3. 썸네일 그리드에서 탭하거나 **슬라이드 보기**로 전체화면에서 넘겨 봅니다.
4. 좌우 **스와이프** 또는 ‹ › 버튼으로 이전/다음 사진
5. **사진 더 추가**로 이어서 불러올 수 있습니다.

### 문서 스캔 보정

1. **문서 스캔 보정** 탭에서 문서 사진을 업로드합니다.
2. OpenCV.js 로딩이 완료될 때까지 기다립니다.
3. 컬러/흑백 모드와 JPG 품질을 선택합니다.
4. **보정 실행** 후 결과를 다운로드합니다.

자동 문서 영역 감지에 실패하면 전체 이미지 기준으로 보정하며, 화면에 안내 메시지가 표시됩니다.

## 사용 라이브러리

| 라이브러리 | 용도 | CDN |
|-----------|------|-----|
| [PDF.js](https://mozilla.github.io/pdf.js/) | PDF → JPG 변환 | cdnjs |
| [JSZip](https://stuk.github.io/jszip/) | 여러 JPG ZIP 압축 | cdnjs |
| [FileSaver.js](https://github.com/eligrey/FileSaver.js/) | 파일 다운로드 | cdnjs |
| [pica](https://github.com/nodeca/pica) | 고품질 2배 리사이즈 | jsDelivr |
| [OpenCV.js](https://docs.opencv.org/) | 문서 영역 감지·보정 | OpenCV 공식 |

## 주의사항

- **파일 크기**: PDF 50MB, 이미지 30MB 이하를 권장합니다. 더 큰 파일은 브라우저가 느려지거나 멈출 수 있습니다.
- **캔버스 한도**: 결과 이미지가 너무 크면(약 16384px) 처리가 거부됩니다. 세로 합치기 시 5천만 픽셀 이상이면 경고가 표시됩니다.
- **자동 축소**: 입력 이미지가 너무 크면 처리 가능한 크기로 자동 축소 후 진행합니다.
- **OpenCV.js**: 최초 로드 시 수 MB~수십 MB를 다운로드하므로 첫 방문 시 로딩이 다소 걸릴 수 있습니다.
- **AI 업스케일 미지원**: 2배 확대는 pica 기반 고품질 리사이즈이며, 서버 기반 AI 업스케일은 포함하지 않습니다.
- **브라우저 호환**: Chrome, Edge, Firefox 최신 버전을 권장합니다.
- **개인정보**: 모든 처리는 브라우저 내에서만 이루어지며 외부 서버로 파일이 전송되지 않습니다.

## 향후 개선 가능 기능

- [ ] PDF → JPG 페이지 범위 선택 (특정 페이지만 변환)
- [ ] 이미지 줄이기 사용자 지정 비율 입력
- [ ] 가로 방향 이미지 합치기
- [ ] 드래그로 이미지 합치기 순서 변경
- [ ] 문서 보정 수동 꼭짓점 조정 UI
- [ ] WebAssembly 기반 업스케일 (예: waifu2x) 옵션 추가
- [ ] PWA(오프라인) 지원
- [ ] 다국어(영어) UI

## 최종 결과물

```
project-root/
├─ index.html
├─ style.css
├─ app.js
├─ README.md
├─ manifest.json
├─ icon.svg
├─ .nojekyll
├─ .gitignore
└─ .github/workflows/deploy.yml
```

### 자동 파일명 규칙

| 기능 | 예시 파일명 |
|------|------------|
| PDF → JPG | `original_page_1.jpg`, `original_page_2.jpg` |
| 이미지 줄이기 | `resized_50_original.jpg` |
| 2배 확대 | `upscale_2x_original.png` |
| 세로 합치기 | `merged_vertical.jpg` |
| 문서 스캔 | `scanned_document.jpg` |

---

MIT License · 자유롭게 사용·수정·배포할 수 있습니다.