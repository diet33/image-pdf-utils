/* eslint-disable no-undef */
'use strict';

// ─── Constants (iPhone Safari는 메모리 한도가 낮음) ───────────
let MAX_PDF_SIZE_MB = 50;
let MAX_IMAGE_SIZE_MB = 30;
let MAX_CANVAS_SIDE = 16384;
let WARN_MERGE_PIXELS = 50_000_000;
let MAX_UPSCALE_INPUT_SIDE = 4096;
let PDF_RENDER_SCALE = 2.0;
let SCAN_MAX_SIDE = 3000;

function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isMobile() {
  return isIOS() || window.innerWidth <= 600;
}

function applyDeviceLimits() {
  if (isIOS()) {
    MAX_PDF_SIZE_MB = 20;
    MAX_IMAGE_SIZE_MB = 15;
    MAX_CANVAS_SIDE = 4096;
    MAX_UPSCALE_INPUT_SIDE = 2048;
    WARN_MERGE_PIXELS = 20_000_000;
    PDF_RENDER_SCALE = 1.5;
    SCAN_MAX_SIDE = 2000;
    document.body.classList.add('is-ios');
  }
  if (isMobile()) {
    document.body.classList.add('is-mobile');
  }
  document.querySelectorAll('.limit-pdf').forEach(function (el) {
    el.textContent = String(MAX_PDF_SIZE_MB);
  });
  document.querySelectorAll('.limit-image').forEach(function (el) {
    el.textContent = String(MAX_IMAGE_SIZE_MB);
  });
  const iosTip = document.getElementById('ios-tip');
  if (iosTip && isIOS()) iosTip.classList.remove('hidden');
}

// ─── pdf.js worker ─────────────────────────────────────────
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ─── OpenCV ready ────────────────────────────────────────────
window.opencvReady = false;

window.onOpenCvReady = function () {
  if (window._opencvInitDone) return;
  window._opencvInitDone = true;
  window.opencvReady = typeof cv !== 'undefined' && typeof cv.Mat === 'function';
  const el = document.getElementById('opencv-status');
  if (!el) return;
  if (window.opencvReady) {
    el.textContent = isIOS()
      ? 'OpenCV.js 준비 완료 (Wi-Fi 환경 권장)'
      : 'OpenCV.js 준비 완료';
    el.classList.add('ready');
  } else {
    el.textContent = 'OpenCV.js 로드 실패. 페이지를 새로고침해 주세요.';
    el.classList.add('error');
  }
  if (typeof updateScanButton === 'function') updateScanButton();
};

// ─── Per-tab state ───────────────────────────────────────────
const state = {
  'pdf-jpg': { files: [], results: [] },
  resize: { files: [], results: [] },
  upscale: { files: [], results: [] },
  merge: { files: [], results: [] },
  scan: { files: [], results: [] },
};

// ─── Utility helpers ─────────────────────────────────────────
function yieldToMain() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getBaseName(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function getExt(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : 'jpg';
}

function getActiveTabId() {
  const active = document.querySelector('.tab-panel.active');
  return active ? active.id : 'pdf-jpg';
}

function setStatus(tabId, message, type) {
  const el = document.getElementById(tabId + '-status');
  el.textContent = message || '';
  el.className = 'status' + (type ? ' ' + type : '');
}

function setLoading(tabId, show) {
  const el = document.getElementById(tabId + '-loading');
  el.classList.toggle('hidden', !show);
}

function showFileInfo(tabId, files) {
  const el = document.getElementById(tabId + '-file-info');
  if (!files || files.length === 0) {
    el.classList.remove('visible');
    el.innerHTML = '';
    return;
  }
  el.classList.add('visible');
  el.innerHTML = files
    .map(function (f) {
      return '<div class="file-item">📎 ' + escapeHtml(f.name) + ' (' + formatSize(f.size) + ')</div>';
    })
    .join('');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(function (resolve, reject) {
    canvas.toBlob(
      function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('이미지 변환에 실패했습니다.'));
      },
      type,
      quality
    );
  });
}

async function downloadBlob(blob, filename) {
  if (isIOS()) {
    if (navigator.share && typeof File !== 'undefined') {
      try {
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    if (blob.type && blob.type.indexOf('image/') === 0) {
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, '_blank');
      if (!opened) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 60000);
      return;
    }

    try {
      saveAs(blob, filename);
    } catch (e) {
      throw new Error('iPhone에서는 ZIP 저장이 제한될 수 있습니다. 이미지를 개별로 저장해 주세요.');
    }
    return;
  }

  saveAs(blob, filename);
}

function loadImageFromFile(file) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 불러올 수 없습니다: ' + file.name));
    };
    img.src = url;
  });
}

function imageFileToCanvas(img, maxSide) {
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  let scaled = false;

  if (maxSide && Math.max(w, h) > maxSide) {
    const ratio = maxSide / Math.max(w, h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
    scaled = true;
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas: canvas, scaled: scaled, originalW: img.naturalWidth, originalH: img.naturalHeight };
}

function checkCanvasLimits(width, height, context) {
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new Error(
      '결과 이미지가 너무 큽니다 (' +
        width +
        '×' +
        height +
        'px). 더 작은 이미지를 사용해 주세요.'
    );
  }
  const pixels = width * height;
  if (pixels > MAX_CANVAS_SIDE * MAX_CANVAS_SIDE) {
    throw new Error('결과 이미지 픽셀 수가 브라우저 한도를 초과합니다.');
  }
  return pixels;
}

function clearResults(tabId) {
  const el = document.getElementById(tabId + '-results');
  el.querySelectorAll('.result-card').forEach(function (card) {
    if (card._objectUrl) URL.revokeObjectURL(card._objectUrl);
  });
  el.innerHTML = '';
  el.classList.remove('compare');
  state[tabId].results = [];

  const batchEl = document.getElementById(tabId + '-batch');
  if (batchEl) batchEl.classList.add('hidden');
}

function setProgress(tabId, percent) {
  const wrap = document.getElementById(tabId + '-progress-wrap');
  const fill = document.getElementById(tabId + '-progress');
  if (!wrap || !fill) return;
  if (percent < 0) {
    wrap.classList.add('hidden');
    fill.style.width = '0%';
    return;
  }
  wrap.classList.remove('hidden');
  fill.style.width = Math.min(100, Math.max(0, percent)) + '%';
}

function createPreviewCard(title, imageSrc, meta) {
  const card = document.createElement('div');
  card.className = 'result-card preview';

  const img = document.createElement('img');
  img.src = imageSrc;
  img.alt = title;
  img.loading = 'lazy';

  const body = document.createElement('div');
  body.className = 'card-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = title;

  const metaEl = document.createElement('div');
  metaEl.className = 'card-meta';
  metaEl.textContent = meta;

  body.appendChild(titleEl);
  body.appendChild(metaEl);
  card.appendChild(img);
  card.appendChild(body);
  card._objectUrl = imageSrc;
  return card;
}

function createResultCard(title, meta, blob, downloadName, single) {
  const url = URL.createObjectURL(blob);
  const card = document.createElement('div');
  card.className = 'result-card' + (single ? ' single' : '');

  const img = document.createElement('img');
  img.src = url;
  img.alt = title;
  img.loading = 'lazy';

  const body = document.createElement('div');
  body.className = 'card-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = title;

  const metaEl = document.createElement('div');
  metaEl.className = 'card-meta';
  metaEl.textContent = meta;

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-download';
  btn.textContent = isIOS() ? '저장 / 공유' : '다운로드';
  btn.addEventListener('click', async function () {
    try {
      await downloadBlob(blob, downloadName);
      if (isIOS() && blob.type && blob.type.indexOf('image/') === 0) {
        setStatus(getActiveTabId(), '이미지가 열렸습니다. 길게 눌러 「사진 저장」을 선택하세요.', 'info');
      }
    } catch (err) {
      setStatus(getActiveTabId(), err.message, 'error');
    }
  });

  actions.appendChild(btn);

  if (isIOS()) {
    const hint = document.createElement('div');
    hint.className = 'save-hint';
    hint.textContent = '공유 버튼이 안 되면 이미지를 길게 눌러 사진 앱에 저장하세요.';
    actions.appendChild(hint);
  }
  body.appendChild(titleEl);
  body.appendChild(metaEl);
  body.appendChild(actions);
  card.appendChild(img);
  card.appendChild(body);

  card._objectUrl = url;
  return card;
}

function renderResults(tabId, items) {
  const el = document.getElementById(tabId + '-results');
  el.innerHTML = '';
  items.forEach(function (item) {
    el.appendChild(
      createResultCard(item.title, item.meta, item.blob, item.filename, item.single)
    );
  });
  state[tabId].results = items;
}

function validateImageFile(file) {
  const valid = ['image/jpeg', 'image/png', 'image/webp'];
  if (!valid.includes(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) {
    throw new Error('지원하지 않는 이미지 형식입니다: ' + file.name);
  }
  if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    throw new Error(
      file.name + ' 파일이 너무 큽니다 (' + formatSize(file.size) + '). ' + MAX_IMAGE_SIZE_MB + 'MB 이하를 권장합니다.'
    );
  }
}

function validatePdfFile(file) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('PDF 파일만 업로드할 수 있습니다.');
  }
  if (file.size > MAX_PDF_SIZE_MB * 1024 * 1024) {
    throw new Error(
      'PDF 파일이 너무 큽니다 (' + formatSize(file.size) + '). ' + MAX_PDF_SIZE_MB + 'MB 이하를 권장합니다.'
    );
  }
}

async function downloadZip(items, zipName) {
  const zip = new JSZip();
  items.forEach(function (item) {
    zip.file(item.filename, item.blob);
  });
  const content = await zip.generateAsync({ type: 'blob' });
  downloadBlob(content, zipName);
}

// ─── Tab switching ───────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.remove('active');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById(tab).classList.add('active');
  });
});

// ─── Drag & drop + file triggers ─────────────────────────────
function setupDropZone(tabId, inputId, onFiles) {
  const zone = document.querySelector('[data-drop="' + tabId + '"]');
  const input = document.getElementById(inputId);

  zone.addEventListener('click', function (e) {
    if (e.target.closest('.link-btn')) return;
    input.click();
  });

  document.querySelectorAll('[data-trigger="' + inputId + '"]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      input.click();
    });
  });

  input.addEventListener('change', function () {
    if (input.files.length) onFiles(Array.from(input.files));
    input.value = '';
  });

  zone.addEventListener('dragover', function (e) {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', function () {
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
  });
}

function setupReset(tabId, runBtnId, onReset) {
  document.getElementById(tabId + '-reset').addEventListener('click', function () {
    state[tabId].files = [];
    clearResults(tabId);
    showFileInfo(tabId, []);
    setStatus(tabId, '');
    document.getElementById(runBtnId).disabled = true;
    if (onReset) onReset();
  });
}

// ─── Feature 1: PDF → JPG ────────────────────────────────────
function initPdfJpg() {
  const runBtn = document.getElementById('pdf-jpg-run');

  setupDropZone('pdf-jpg', 'pdf-jpg-input', function (files) {
    try {
      if (files.length > 1) throw new Error('PDF 파일은 한 번에 하나만 선택할 수 있습니다.');
      validatePdfFile(files[0]);
      state['pdf-jpg'].files = [files[0]];
      clearResults('pdf-jpg');
      showFileInfo('pdf-jpg', state['pdf-jpg'].files);
      setStatus('pdf-jpg', '파일이 선택되었습니다. 변환 실행을 눌러 주세요.', 'info');
      runBtn.disabled = false;
    } catch (err) {
      setStatus('pdf-jpg', err.message, 'error');
    }
  });

  setupReset('pdf-jpg', 'pdf-jpg-run');

  runBtn.addEventListener('click', async function () {
    const file = state['pdf-jpg'].files[0];
    if (!file) return;

    if (typeof pdfjsLib === 'undefined') {
      setStatus('pdf-jpg', 'PDF.js 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.', 'error');
      return;
    }

    const quality = parseFloat(document.getElementById('pdf-jpg-quality').value);
    const baseName = getBaseName(file.name);

    runBtn.disabled = true;
    setLoading('pdf-jpg', true);
    clearResults('pdf-jpg');
    setProgress('pdf-jpg', 0);
    setStatus('pdf-jpg', 'PDF를 읽는 중...', 'info');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const total = pdf.numPages;
      const items = [];

      for (let i = 1; i <= total; i++) {
        await yieldToMain();
        const pct = Math.round((i / total) * 100);
        setProgress('pdf-jpg', pct);
        setStatus('pdf-jpg', '페이지 변환 중... (' + i + '/' + total + ')', 'info');
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });

        checkCanvasLimits(Math.floor(viewport.width), Math.floor(viewport.height), 'pdf');

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        const filename = baseName + '_page_' + i + '.jpg';
        items.push({
          title: '페이지 ' + i,
          meta: formatSize(blob.size) + ' · ' + canvas.width + '×' + canvas.height + 'px',
          blob: blob,
          filename: filename,
        });
      }

      renderResults('pdf-jpg', items);
      document.getElementById('pdf-jpg-batch').classList.remove('hidden');
      setProgress('pdf-jpg', 100);
      setStatus('pdf-jpg', total + '개 페이지 변환 완료!', 'success');
    } catch (err) {
      setStatus('pdf-jpg', err.message || 'PDF 변환 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('pdf-jpg', false);
      setProgress('pdf-jpg', -1);
      runBtn.disabled = false;
    }
  });

  document.getElementById('pdf-jpg-zip').addEventListener('click', async function () {
    const items = state['pdf-jpg'].results;
    if (!items.length) return;
    if (isIOS() && items.length > 1) {
      setStatus('pdf-jpg', 'iPhone에서는 각 페이지를 개별 저장하는 것을 권장합니다.', 'warning');
      await yieldToMain();
    }
    try {
      setStatus('pdf-jpg', 'ZIP 파일 생성 중...', 'info');
      const baseName = getBaseName(state['pdf-jpg'].files[0].name);
      await downloadZip(items, baseName + '_pages.zip');
      setStatus('pdf-jpg', isIOS() ? 'ZIP 저장을 시도했습니다. 실패 시 개별 저장을 이용하세요.' : 'ZIP 다운로드 완료!', 'success');
    } catch (err) {
      setStatus('pdf-jpg', 'ZIP 생성 실패: ' + err.message, 'error');
    }
  });
}

// ─── Feature 2: Image resize ─────────────────────────────────
function initResize() {
  const runBtn = document.getElementById('resize-run');

  setupDropZone('resize', 'resize-input', function (files) {
    try {
      files.forEach(validateImageFile);
      state.resize.files = files;
      clearResults('resize');
      showFileInfo('resize', files);
      setStatus('resize', files.length + '개 이미지 선택됨. 변환 실행을 눌러 주세요.', 'info');
      runBtn.disabled = false;
    } catch (err) {
      setStatus('resize', err.message, 'error');
    }
  });

  setupReset('resize', 'resize-run', function () {
    document.getElementById('resize-batch').classList.add('hidden');
  });

  runBtn.addEventListener('click', async function () {
    const files = state.resize.files;
    if (!files.length) return;

    const scale = parseFloat(document.querySelector('input[name="resize-scale"]:checked').value);
    const pct = Math.round(scale * 100);

    runBtn.disabled = true;
    setLoading('resize', true);
    clearResults('resize');

    const items = [];
    let warnMsg = '';

    try {
      for (let i = 0; i < files.length; i++) {
        await yieldToMain();
        const file = files[i];
        setStatus('resize', '처리 중... (' + (i + 1) + '/' + files.length + ')', 'info');

        const img = await loadImageFromFile(file);
        const prep = imageFileToCanvas(img, MAX_CANVAS_SIDE);
        if (prep.scaled) {
          warnMsg = '일부 이미지가 너무 커서 처리 가능 크기로 축소 후 진행했습니다.';
        }

        const newW = Math.max(1, Math.round(prep.canvas.width * scale));
        const newH = Math.max(1, Math.round(prep.canvas.height * scale));
        checkCanvasLimits(newW, newH, 'resize');

        const out = document.createElement('canvas');
        out.width = newW;
        out.height = newH;
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(prep.canvas, 0, 0, newW, newH);

        const mime = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        const quality = mime === 'image/jpeg' ? 0.92 : undefined;
        const blob = await canvasToBlob(out, mime, quality);

        const base = getBaseName(file.name);
        items.push({
          title: base,
          meta: pct + '% · ' + newW + '×' + newH + 'px · ' + formatSize(blob.size),
          blob: blob,
          filename: 'resized_' + pct + '_' + base + '.' + ext,
        });
      }

      renderResults('resize', items);
      const batchEl = document.getElementById('resize-batch');
      if (items.length > 1) batchEl.classList.remove('hidden');
      else batchEl.classList.add('hidden');
      setStatus('resize', files.length + '개 이미지 축소 완료!' + (warnMsg ? ' ' + warnMsg : ''), warnMsg ? 'warning' : 'success');
    } catch (err) {
      setStatus('resize', err.message || '이미지 축소 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('resize', false);
      runBtn.disabled = false;
    }
  });

  document.getElementById('resize-zip').addEventListener('click', async function () {
    const items = state.resize.results;
    if (items.length < 2) return;
    if (isIOS()) {
      setStatus('resize', 'iPhone에서는 각 이미지를 개별 저장하는 것을 권장합니다.', 'warning');
    }
    try {
      setStatus('resize', 'ZIP 파일 생성 중...', 'info');
      await downloadZip(items, 'resized_images.zip');
      setStatus('resize', isIOS() ? 'ZIP 저장을 시도했습니다. 실패 시 개별 저장을 이용하세요.' : 'ZIP 다운로드 완료!', 'success');
    } catch (err) {
      setStatus('resize', 'ZIP 생성 실패: ' + err.message, 'error');
    }
  });
}

// ─── Feature 3: Image upscale 2x ─────────────────────────────
function initUpscale() {
  const runBtn = document.getElementById('upscale-run');

  setupDropZone('upscale', 'upscale-input', function (files) {
    try {
      if (files.length > 1) throw new Error('2배 확대는 한 번에 하나의 이미지만 처리합니다.');
      validateImageFile(files[0]);
      state.upscale.files = [files[0]];
      clearResults('upscale');
      showFileInfo('upscale', state.upscale.files);
      setStatus('upscale', '파일이 선택되었습니다. 2배 확대 실행을 눌러 주세요.', 'info');
      runBtn.disabled = false;
    } catch (err) {
      setStatus('upscale', err.message, 'error');
    }
  });

  setupReset('upscale', 'upscale-run');

  runBtn.addEventListener('click', async function () {
    const file = state.upscale.files[0];
    if (!file) return;

    if (typeof pica === 'undefined') {
      setStatus('upscale', 'pica 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.', 'error');
      return;
    }

    const format = document.getElementById('upscale-format').value;
    const ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';
    const quality = format === 'image/jpeg' ? 0.92 : format === 'image/webp' ? 0.9 : undefined;

    runBtn.disabled = true;
    setLoading('upscale', true);
    clearResults('upscale');
    setStatus('upscale', '고품질 2배 확대 중...', 'info');

    try {
      const img = await loadImageFromFile(file);
      const prep = imageFileToCanvas(img, MAX_UPSCALE_INPUT_SIDE);
      let warnMsg = '';

      if (prep.scaled) {
        warnMsg = '입력 이미지가 커서 ' + MAX_UPSCALE_INPUT_SIDE + 'px 이하로 축소 후 2배 확대했습니다.';
      }

      const destW = prep.canvas.width * 2;
      const destH = prep.canvas.height * 2;
      checkCanvasLimits(destW, destH, 'upscale');

      const destCanvas = document.createElement('canvas');
      destCanvas.width = destW;
      destCanvas.height = destH;

      const picaInstance = pica();
      await picaInstance.resize(prep.canvas, destCanvas, {
        unsharpAmount: 80,
        unsharpRadius: 0.6,
        unsharpThreshold: 2,
      });

      const blob = await canvasToBlob(destCanvas, format, quality);
      const base = getBaseName(file.name);

      renderResults('upscale', [
        {
          title: base + ' (2배)',
          meta: destW + '×' + destH + 'px · ' + formatSize(blob.size),
          blob: blob,
          filename: 'upscale_2x_' + base + '.' + ext,
          single: true,
        },
      ]);

      setStatus('upscale', '2배 확대 완료!' + (warnMsg ? ' ' + warnMsg : ''), warnMsg ? 'warning' : 'success');
    } catch (err) {
      setStatus('upscale', err.message || '이미지 확대 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('upscale', false);
      runBtn.disabled = false;
    }
  });
}

// ─── Feature 4: Vertical merge ───────────────────────────────
function initMerge() {
  const runBtn = document.getElementById('merge-run');
  const customWrap = document.getElementById('merge-custom-wrap');

  document.querySelectorAll('input[name="merge-width"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      const mode = document.querySelector('input[name="merge-width"]:checked').value;
      customWrap.classList.toggle('hidden', mode !== 'custom');
    });
  });

  setupDropZone('merge', 'merge-input', function (files) {
    try {
      if (files.length < 2) throw new Error('세로 합치기는 2장 이상의 이미지가 필요합니다.');
      files.forEach(validateImageFile);
      state.merge.files = files;
      clearResults('merge');
      showFileInfo('merge', files);
      setStatus('merge', files.length + '개 이미지 선택됨. 합치기 실행을 눌러 주세요.', 'info');
      runBtn.disabled = false;
    } catch (err) {
      setStatus('merge', err.message, 'error');
    }
  });

  setupReset('merge', 'merge-run');

  runBtn.addEventListener('click', async function () {
    const files = state.merge.files;
    if (files.length < 2) return;

    const widthMode = document.querySelector('input[name="merge-width"]:checked').value;
    const format = document.getElementById('merge-format').value;
    const quality = parseFloat(document.getElementById('merge-quality').value);
    const ext = format === 'image/png' ? 'png' : 'jpg';

    runBtn.disabled = true;
    setLoading('merge', true);
    clearResults('merge');
    setStatus('merge', '이미지 불러오는 중...', 'info');

    try {
      const images = [];
      for (let i = 0; i < files.length; i++) {
        const img = await loadImageFromFile(files[i]);
        images.push(img);
      }

      let targetWidth;
      if (widthMode === 'first') {
        targetWidth = images[0].naturalWidth;
      } else if (widthMode === 'max') {
        targetWidth = Math.max.apply(null, images.map(function (im) { return im.naturalWidth; }));
      } else {
        targetWidth = parseInt(document.getElementById('merge-custom-width').value, 10);
        if (!targetWidth || targetWidth < 100 || targetWidth > 8000) {
          throw new Error('폭은 100~8000px 사이로 입력해 주세요.');
        }
      }

      const scaled = images.map(function (img) {
        const ratio = targetWidth / img.naturalWidth;
        return {
          img: img,
          w: targetWidth,
          h: Math.round(img.naturalHeight * ratio),
        };
      });

      const totalHeight = scaled.reduce(function (sum, s) { return sum + s.h; }, 0);
      const totalPixels = targetWidth * totalHeight;
      checkCanvasLimits(targetWidth, totalHeight, 'merge');

      let warnMsg = '';
      if (totalPixels > WARN_MERGE_PIXELS) {
        warnMsg =
          '결과 이미지가 매우 큽니다 (' +
          targetWidth +
          '×' +
          totalHeight +
          'px, 약 ' +
          Math.round(totalPixels / 1_000_000) +
          'MP). 브라우저가 느려지거나 실패할 수 있습니다.';
      }

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = totalHeight;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let y = 0;
      for (let i = 0; i < scaled.length; i++) {
        await yieldToMain();
        setStatus('merge', '합치는 중... (' + (i + 1) + '/' + scaled.length + ')', 'info');
        ctx.drawImage(scaled[i].img, 0, y, scaled[i].w, scaled[i].h);
        y += scaled[i].h;
      }

      const blob = await canvasToBlob(canvas, format, format === 'image/jpeg' ? quality : undefined);
      const base = getBaseName(files[0].name);

      renderResults('merge', [
        {
          title: '세로 합친 이미지',
          meta: targetWidth + '×' + totalHeight + 'px · ' + formatSize(blob.size),
          blob: blob,
          filename: 'merged_vertical.' + ext,
          single: true,
        },
      ]);

      setStatus('merge', '이미지 합치기 완료!' + (warnMsg ? ' ' + warnMsg : ''), warnMsg ? 'warning' : 'success');
    } catch (err) {
      setStatus('merge', err.message || '이미지 합치기 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('merge', false);
      runBtn.disabled = false;
    }
  });
}

// ─── Feature 5: Document scan (OpenCV.js) ────────────────────
function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function orderPoints(pts) {
  const sorted = pts.slice().sort(function (a, b) { return a.y - b.y; });
  const top = sorted.slice(0, 2).sort(function (a, b) { return a.x - b.x; });
  const bottom = sorted.slice(2, 4).sort(function (a, b) { return a.x - b.x; });
  return [top[0], top[1], bottom[1], bottom[0]];
}

function findDocumentCornersWithParams(src, cannyLow, cannyHigh, epsilonRatio, minAreaRatio) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, cannyLow, cannyHigh);

  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);

  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const imageArea = src.rows * src.cols;
  let maxArea = 0;
  let bestPoints = null;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const peri = cv.arcLength(contour, true);
    if (peri < 100) {
      contour.delete();
      continue;
    }
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, epsilonRatio * peri, true);

    if (approx.rows === 4 && cv.isContourConvex(approx)) {
      const area = cv.contourArea(approx);
      if (area > maxArea && area > imageArea * minAreaRatio && area < imageArea * 0.98) {
        maxArea = area;
        const pts = [];
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        }
        bestPoints = orderPoints(pts);
      }
    }
    approx.delete();
    contour.delete();
  }

  gray.delete();
  blurred.delete();
  edges.delete();
  closed.delete();
  kernel.delete();
  contours.delete();
  hierarchy.delete();

  return bestPoints;
}

function findDocumentCorners(src) {
  const strategies = [
    [75, 200, 0.02, 0.15],
    [50, 150, 0.03, 0.10],
    [100, 250, 0.015, 0.20],
  ];
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    const corners = findDocumentCornersWithParams(src, s[0], s[1], s[2], s[3]);
    if (corners) return corners;
  }
  return null;
}

function warpDocument(src, corners) {
  const tl = corners[0];
  const tr = corners[1];
  const br = corners[2];
  const bl = corners[3];

  const maxWidth = Math.max(distance(tl, tr), distance(bl, br));
  const maxHeight = Math.max(distance(tl, bl), distance(tr, br));

  const srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, maxWidth - 1, 0, maxWidth - 1, maxHeight - 1, 0, maxHeight - 1,
  ]);

  const M = cv.getPerspectiveTransform(srcCoords, dstCoords);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(Math.round(maxWidth), Math.round(maxHeight)));

  srcCoords.delete();
  dstCoords.delete();
  M.delete();

  return dst;
}

function sharpenMat(src) {
  const result = new cv.Mat();
  const kernel = cv.matFromArray(3, 3, cv.CV_32FC1, [0, -1, 0, -1, 5, -1, 0, -1, 0]);
  cv.filter2D(src, result, -1, kernel);
  kernel.delete();
  return result;
}

function enhanceColorScan(src) {
  const bgr = new cv.Mat();
  cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);

  const lab = new cv.Mat();
  cv.cvtColor(bgr, lab, cv.COLOR_BGR2Lab);

  const channels = new cv.MatVector();
  cv.split(lab, channels);

  const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
  const lChannel = channels.get(0);
  const enhanced = new cv.Mat();
  clahe.apply(lChannel, enhanced);
  enhanced.copyTo(channels.get(0));

  const merged = new cv.Mat();
  cv.merge(channels, merged);

  const result = new cv.Mat();
  cv.cvtColor(merged, result, cv.COLOR_Lab2BGR);
  cv.cvtColor(result, result, cv.COLOR_BGR2RGBA);

  bgr.delete();
  lab.delete();
  channels.delete();
  clahe.delete();
  lChannel.delete();
  enhanced.delete();
  merged.delete();

  return result;
}

function processBwScan(gray) {
  const denoised = new cv.Mat();
  cv.medianBlur(gray, denoised, 3);

  const binary = new cv.Mat();
  cv.adaptiveThreshold(denoised, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 8);

  const result = new cv.Mat();
  cv.cvtColor(binary, result, cv.COLOR_GRAY2RGBA);

  denoised.delete();
  binary.delete();

  return result;
}

function matToBlob(mat, quality) {
  const canvas = document.createElement('canvas');
  cv.imshow(canvas, mat);
  return canvasToBlob(canvas, 'image/jpeg', quality);
}

function imageToCvMat(img, maxSide) {
  const prep = imageFileToCanvas(img, maxSide);
  const mat = cv.imread(prep.canvas);
  return { mat: mat, scaled: prep.scaled };
}

async function scanDocument(file, mode, quality) {
  const img = await loadImageFromFile(file);
  const { mat: src, scaled } = imageToCvMat(img, SCAN_MAX_SIDE);

  let detectionFailed = false;
  let working = src.clone();

  const corners = findDocumentCorners(working);
  if (corners) {
    const warped = warpDocument(working, corners);
    working.delete();
    working = warped;
  } else {
    detectionFailed = true;
  }

  let result;
  if (mode === 'bw') {
    const gray = new cv.Mat();
    cv.cvtColor(working, gray, cv.COLOR_RGBA2GRAY);
    const sharp = sharpenMat(gray);
    result = processBwScan(sharp);
    gray.delete();
    sharp.delete();
  } else {
    const enhanced = enhanceColorScan(working);
    result = sharpenMat(enhanced);
    enhanced.delete();
  }

  working.delete();
  src.delete();

  const blob = await matToBlob(result, quality);
  result.delete();

  return { blob: blob, detectionFailed: detectionFailed, inputScaled: scaled };
}

function updateScanButton() {
  const runBtn = document.getElementById('scan-run');
  const hasFile = state.scan.files.length > 0;
  runBtn.disabled = !hasFile || !window.opencvReady;
}

function initScan() {
  const runBtn = document.getElementById('scan-run');
  window.updateScanButton = updateScanButton;

  function handleScanFiles(files) {
    try {
      if (files.length > 1) throw new Error('문서 보정은 한 번에 하나의 이미지만 처리합니다.');
      validateImageFile(files[0]);
      state.scan.files = [files[0]];
      clearResults('scan');
      showFileInfo('scan', state.scan.files);
      setStatus('scan', '파일이 선택되었습니다. 보정 실행을 눌러 주세요.', 'info');
      updateScanButton();
    } catch (err) {
      setStatus('scan', err.message, 'error');
    }
  }

  setupDropZone('scan', 'scan-input', handleScanFiles);

  const cameraInput = document.getElementById('scan-camera-input');
  document.getElementById('scan-camera-btn').addEventListener('click', function () {
    cameraInput.click();
  });
  document.getElementById('scan-album-btn').addEventListener('click', function () {
    document.getElementById('scan-input').click();
  });
  cameraInput.addEventListener('change', function () {
    if (cameraInput.files.length) handleScanFiles(Array.from(cameraInput.files));
    cameraInput.value = '';
  });

  setupReset('scan', 'scan-run', updateScanButton);

  runBtn.addEventListener('click', async function () {
    const file = state.scan.files[0];
    if (!file) return;

    if (!window.opencvReady) {
      setStatus('scan', 'OpenCV.js가 아직 로드되지 않았습니다. 잠시 후 다시 시도해 주세요.', 'error');
      return;
    }

    const mode = document.querySelector('input[name="scan-mode"]:checked').value;
    const quality = parseFloat(document.getElementById('scan-quality').value);

    runBtn.disabled = true;
    setLoading('scan', true);
    clearResults('scan');
    setStatus('scan', '문서 영역 분석 및 보정 중...', 'info');

    try {
      const result = await scanDocument(file, mode, quality);
      const base = getBaseName(file.name);

      const resultsEl = document.getElementById('scan-results');
      resultsEl.innerHTML = '';
      resultsEl.classList.add('compare');

      const originalUrl = URL.createObjectURL(file);
      resultsEl.appendChild(
        createPreviewCard('원본', originalUrl, file.name + ' · ' + formatSize(file.size))
      );
      resultsEl.appendChild(
        createResultCard(
          '보정된 문서',
          (mode === 'bw' ? '흑백' : '컬러') + ' · ' + formatSize(result.blob.size),
          result.blob,
          'scanned_' + base + '.jpg',
          false
        )
      );

      state.scan.results = [
        {
          title: '보정된 문서',
          meta: (mode === 'bw' ? '흑백' : '컬러') + ' · ' + formatSize(result.blob.size),
          blob: result.blob,
          filename: 'scanned_' + base + '.jpg',
        },
      ];

      let msg = '문서 보정 완료!';
      let type = 'success';

      if (result.detectionFailed) {
        msg = '문서 영역 자동 감지 실패, 전체 이미지 기준으로 보정했습니다.';
        type = 'warning';
      }
      if (result.inputScaled) {
        msg += ' (입력 이미지가 커서 처리 가능 크기로 축소 후 진행했습니다.)';
        if (type === 'success') type = 'warning';
      }

      setStatus('scan', msg, type);
    } catch (err) {
      setStatus('scan', err.message || '문서 보정 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('scan', false);
      updateScanButton();
    }
  });

  setTimeout(function () {
    if (!window.opencvReady) {
      const el = document.getElementById('opencv-status');
      if (!el.classList.contains('ready')) {
        el.textContent = 'OpenCV.js 로딩 중... (느린 네트워크에서는 시간이 걸릴 수 있습니다)';
      }
    }
  }, 8000);
}

// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  applyDeviceLimits();
  initPdfJpg();
  initResize();
  initUpscale();
  initMerge();
  initScan();
});

window.addEventListener('resize', function () {
  if (window.innerWidth <= 600) document.body.classList.add('is-mobile');
  else document.body.classList.remove('is-mobile');
});