#!/usr/bin/env python3
"""올인원 이미지/PDF 유틸리티 — 로컬 통합 테스트"""
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8081")
ASSETS = Path(__file__).resolve().parent / "assets"

passed = 0
failed = 0
errors = []


def ok(name):
    global passed
    passed += 1
    print(f"  PASS  {name}")


def fail(name, detail=""):
    global failed
    failed += 1
    msg = f"  FAIL  {name}" + (f" — {detail}" if detail else "")
    print(msg)
    errors.append(msg)


def fetch(path):
    url = BASE_URL.rstrip("/") + path
    req = urllib.request.Request(url, headers={"User-Agent": "GROK-TestRunner/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, resp.read(), resp.headers.get_content_type()


def test_static_files():
    print("\n[1] 정적 파일 HTTP 응답")
    required = [
        ("/", "text/html"),
        ("/index.html", "text/html"),
        ("/style.css", "text/css"),
        ("/app.js", "text/javascript"),
        ("/manifest.json", "application/json"),
        ("/icon.svg", "image/svg+xml"),
        ("/.nojekyll", "text/plain"),
    ]
    for path, expected_type in required:
        try:
            status, body, ctype = fetch(path)
            if status != 200:
                fail(f"GET {path}", f"status={status}")
                continue
            ctype = ctype or ""
            mime_ok = expected_type in ctype
            if not mime_ok and expected_type == "text/javascript":
                mime_ok = "javascript" in ctype
            if not mime_ok and expected_type == "text/plain" and path == "/.nojekyll":
                mime_ok = len(body) == 0 or ctype in ("text/plain", "application/octet-stream")
            if not mime_ok:
                fail(f"GET {path}", f"ctype={ctype}, expected~={expected_type}")
                continue
            if len(body) < 10 and path != "/.nojekyll":
                fail(f"GET {path}", "empty body")
                continue
            ok(f"GET {path} ({len(body)} bytes)")
        except Exception as e:
            fail(f"GET {path}", str(e))


def test_html_structure():
    print("\n[2] HTML 구조")
    _, html, _ = fetch("/index.html")
    text = html.decode("utf-8", errors="replace")
    checks = [
        ("title", "올인원 이미지/PDF 유틸리티"),
        ("tab pdf-jpg", 'id="pdf-jpg"'),
        ("tab resize", 'id="resize"'),
        ("tab upscale", 'id="upscale"'),
        ("tab merge", 'id="merge"'),
        ("tab scan", 'id="scan"'),
        ("pdf.js cdn", "pdf.min.js"),
        ("jszip cdn", "jszip"),
        ("pica cdn", "pica"),
        ("opencv cdn", "opencv.js"),
        ("ios tip", "ios-tip"),
        ("scan camera", "scan-camera-btn"),
        ("manifest", "manifest.json"),
    ]
    for name, needle in checks:
        if needle in text:
            ok(name)
        else:
            fail(name, f"missing: {needle}")


def test_app_js():
    print("\n[3] app.js 핵심 함수")
    _, js, _ = fetch("/app.js")
    text = js.decode("utf-8", errors="replace")
    funcs = [
        "initPdfJpg", "initResize", "initUpscale", "initMerge", "initScan",
        "findDocumentCorners", "downloadBlob", "applyDeviceLimits", "isIOS",
        "yieldToMain", "downloadZip",
    ]
    for fn in funcs:
        if re.search(rf"function\s+{fn}\b", text):
            ok(fn)
        else:
            fail(fn, "function not found")


def test_manifest():
    print("\n[4] manifest.json")
    _, raw, _ = fetch("/manifest.json")
    data = json.loads(raw.decode("utf-8"))
    if data.get("name") and data.get("start_url"):
        ok("manifest fields")
    else:
        fail("manifest fields", str(data))


def create_test_assets():
    print("\n[5] 테스트 에셋 생성")
    ASSETS.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image, ImageDraw

        # 색상 테스트 이미지
        img = Image.new("RGB", (400, 300), color=(70, 130, 220))
        draw = ImageDraw.Draw(img)
        draw.rectangle([40, 40, 360, 260], outline=(255, 255, 255), width=4)
        draw.text((60, 130), "TEST IMAGE", fill=(255, 255, 255))
        img.save(ASSETS / "test_image.png")
        ok("test_image.png")

        # 세로 합치기용 2장
        for i, h in enumerate([200, 280], 1):
            im = Image.new("RGB", (300, h), color=(200, 100 + i * 30, 80))
            im.save(ASSETS / f"merge_{i}.png")
        ok("merge images")

        # 간단 PDF (minimal valid PDF)
        pdf = b"""%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 24 Tf 50 100 Td (PDF TEST) Tj ET
endstream endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000214 00000 n 
trailer<< /Size 5 /Root 1 0 R >>
startxref
308
%%EOF"""
        (ASSETS / "test.pdf").write_bytes(pdf)
        ok("test.pdf")
        return True
    except Exception as e:
        fail("asset creation", str(e))
        return False


def test_playwright_browser():
    print("\n[6] Playwright 브라우저 기능 테스트")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        fail("playwright import", "not installed — skipping browser tests")
        return

    if not create_test_assets():
        return

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            page.goto(BASE_URL, wait_until="networkidle", timeout=60000)

            # 탭 전환
            for tab, panel in [
                ("resize", "이미지 사이즈 줄이기"),
                ("upscale", "이미지 2배 확대"),
                ("merge", "이미지 세로 합치기"),
                ("scan", "문서 스캔 보정"),
                ("pdf-jpg", "PDF → JPG"),
            ]:
                page.click(f'button[data-tab="{tab}"]')
                page.wait_for_timeout(200)
                if panel in page.content():
                    ok(f"tab switch: {tab}")
                else:
                    fail(f"tab switch: {tab}")

            # iOS 클래스 / 디바이스 초기화
            page.evaluate("applyDeviceLimits()")
            ok("applyDeviceLimits()")

            # 이미지 줄이기
            page.click('button[data-tab="resize"]')
            page.set_input_files("#resize-input", str(ASSETS / "test_image.png"))
            page.wait_for_timeout(300)
            page.click("#resize-run")
            page.wait_for_selector("#resize-results .result-card", timeout=30000)
            dl = page.locator("#resize-results .btn-download").first
            if dl.is_visible():
                ok("resize: result card + download button")
            else:
                fail("resize: download button")

            # 2배 확대
            page.click('button[data-tab="upscale"]')
            page.click("#upscale-reset")
            page.set_input_files("#upscale-input", str(ASSETS / "test_image.png"))
            page.wait_for_timeout(300)
            page.click("#upscale-run")
            page.wait_for_selector("#upscale-results .result-card", timeout=60000)
            ok("upscale: result generated")

            # 세로 합치기
            page.click('button[data-tab="merge"]')
            page.click("#merge-reset")
            page.set_input_files("#merge-input", [
                str(ASSETS / "merge_1.png"),
                str(ASSETS / "merge_2.png"),
            ])
            page.wait_for_timeout(300)
            page.click("#merge-run")
            page.wait_for_selector("#merge-results .result-card", timeout=30000)
            ok("merge: result generated")

            # PDF → JPG
            page.click('button[data-tab="pdf-jpg"]')
            page.click("#pdf-jpg-reset")
            page.set_input_files("#pdf-jpg-input", str(ASSETS / "test.pdf"))
            page.wait_for_timeout(300)
            page.click("#pdf-jpg-run")
            page.wait_for_selector("#pdf-jpg-results .result-card", timeout=60000)
            ok("pdf-jpg: conversion result")

            # 문서 스캔 (OpenCV 로딩 대기)
            page.click('button[data-tab="scan"]')
            page.wait_for_function(
                "() => window.opencvReady === true",
                timeout=180000,
            )
            ok("opencv: loaded")

            page.set_input_files("#scan-input", str(ASSETS / "test_image.png"))
            page.wait_for_timeout(300)
            page.click("#scan-run")
            page.wait_for_selector("#scan-results .result-card", timeout=120000)
            cards = page.locator("#scan-results .result-card").count()
            if cards >= 2:
                ok(f"scan: {cards} preview cards (original + result)")
            else:
                fail("scan: expected 2 cards", f"got {cards}")

        except Exception as e:
            fail("playwright run", str(e))
        finally:
            browser.close()


def main():
    print(f"Testing: {BASE_URL}")
    print(f"Project: {ROOT}")
    test_static_files()
    test_html_structure()
    test_app_js()
    test_manifest()
    test_playwright_browser()

    print("\n" + "=" * 50)
    print(f"Results: {passed} passed, {failed} failed")
    if errors:
        print("\nFailures:")
        for e in errors:
            print(e)
        sys.exit(1)
    print("All tests passed!")
    sys.exit(0)


if __name__ == "__main__":
    main()