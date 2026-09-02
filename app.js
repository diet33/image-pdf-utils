/* eslint-disable no-undef */
'use strict';

// ─── Constants & Device Limits ─────────────────────────────────
let MAX_PDF_SIZE_MB = 50;
let MAX_IMAGE_SIZE_MB = 30;
let MAX_CANVAS_SIDE = 16384;
let WARN_MERGE_PIXELS = 50_000_000;
let MAX_UPSCALE_INPUT_SIDE = 4096;
let PDF_RENDER_SCALE = 2.0;
let SCAN_MAX_SIDE = 3000;
let MAX_GALLERY_PHOTOS = 1000;

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
    MAX_PDF_SIZE_MB = 25;
    MAX_IMAGE_SIZE_MB = 20;
    MAX_CANVAS_SIDE = 4096;
    MAX_UPSCALE_INPUT_SIDE = 2048;
    WARN_MERGE_PIXELS = 20_000_000;
    PDF_RENDER_SCALE = 1.5;
    SCAN_MAX_SIDE = 2000;
    MAX_GALLERY_PHOTOS = 300;
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

// ─── PDF.js Global Worker ──────────────────────────────────────
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ─── OpenCV State & Callback ───────────────────────────────────
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

// ─── Application State ─────────────────────────────────────────
const state = {
  gallery: { items: [], currentIndex: 0 },
  'pdf-jpg': { files: [], results: [] },
  'img-pdf': { items: [], results: [] },
  resize: { files: [], results: [] },
  convert: { files: [], results: [] },
  upscale: { files: [], results: [] },
  merge: { items: [], results: [] },
  edit: {
    file: null,
    img: null,
    rotation: 0,
    flipH: 1,
    flipV: 1,
    cropper: null
  },
  scan: {
    file: null,
    img: null,
    srcMat: null,
    corners: null,
    canvasScale: 1,
    activeCornerIndex: -1,
    results: []
  }
};

// ─── General Utilities ─────────────────────────────────────────
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

function setStatus(tabId, message, type) {
  const el = document.getElementById(tabId + '-status');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'status' + (type ? ' ' + type : '');
}

function setLoading(tabId, show) {
  const el = document.getElementById(tabId + '-loading');
  if (el) el.classList.toggle('hidden', !show);
}

function setProgress(tabId, percent) {
  const wrap = document.getElementById(tabId + '-progress-wrap');
  const bar = document.getElementById(tabId + '-progress');
  if (!wrap || !bar) return;
  if (percent < 0 || percent > 100) {
    wrap.classList.add('hidden');
    bar.style.width = '0%';
  } else {
    wrap.classList.remove('hidden');
    bar.style.width = percent + '%';
  }
}

function showFileInfo(tabId, files) {
  const el = document.getElementById(tabId + '-file-info');
  if (!el) return;
  if (!files || !files.length) {
    el.innerHTML = '';
    return;
  }
  const totalSize = Array.from(files).reduce(function (sum, f) {
    return sum + (f.size || 0);
  }, 0);
  if (files.length === 1) {
    el.textContent = files[0].name + ' (' + formatSize(files[0].size) + ')';
  } else {
    el.textContent = files.length + '개 파일 선택됨 (총 ' + formatSize(totalSize) + ')';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(function (resolve, reject) {
    try {
      canvas.toBlob(
        function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('캔버스 이미지 생성에 실패했습니다.'));
        },
        type || 'image/jpeg',
        quality !== undefined ? quality : 0.92
      );
    } catch (err) {
      reject(err);
    }
  });
}

async function downloadBlob(blob, filename) {
  if (isIOS() && navigator.canShare) {
    try {
      const ext = getExt(filename);
      const mime = ext === 'png' ? 'image/png' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  if (typeof saveAs !== 'undefined') {
    saveAs(blob, filename);
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }
}

async function downloadZip(items, zipFilename) {
  if (typeof JSZip === 'undefined') {
    throw new Error('JSZip 라이브러리를 찾을 수 없습니다.');
  }
  const zip = new JSZip();
  items.forEach(function (item) {
    zip.file(item.filename, item.blob);
  });
  const content = await zip.generateAsync({ type: 'blob' });
  await downloadBlob(content, zipFilename);
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
      reject(new Error('이미지를 읽을 수 없습니다: ' + file.name));
    };
    img.src = url;
  });
}

function imageFileToCanvas(img, maxSide) {
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  let scaled = false;
  if (maxSide && (w > maxSide || h > maxSide)) {
    const ratio = Math.min(maxSide / w, maxSide / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
    scaled = true;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas: canvas, scaled: scaled };
}

function checkCanvasLimits(width, height, context) {
  const maxSide = MAX_CANVAS_SIDE;
  if (width > maxSide || height > maxSide) {
    throw new Error(
      (context ? '[' + context + '] ' : '') +
      '이미지 크기가 브라우저 지원 한도(' + maxSide + 'px)를 초과합니다.'
    );
  }
}

function clearResults(tabId) {
  const el = document.getElementById(tabId + '-results');
  if (el) el.innerHTML = '';
  if (state[tabId] && state[tabId].results) {
    state[tabId].results = [];
  }
}

function createResultCard(title, meta, blob, downloadName, single) {
  const card = document.createElement('div');
  card.className = 'result-card' + (single ? ' single' : '');

  const imgWrap = document.createElement('div');
  imgWrap.className = 'result-img-wrap';
  const img = document.createElement('img');
  img.src = URL.createObjectURL(blob);
  img.alt = title;
  img.loading = 'lazy';
  imgWrap.appendChild(img);

  const body = document.createElement('div');
  body.className = 'result-body';
  body.innerHTML =
    '<div class="result-title">' + escapeHtml(title) + '</div>' +
    '<div class="result-meta">' + escapeHtml(meta) + '</div>';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary btn-compact btn-download';
  btn.textContent = '저장 / 공유';
  btn.addEventListener('click', function () {
    downloadBlob(blob, downloadName);
  });
  body.appendChild(btn);

  card.appendChild(imgWrap);
  card.appendChild(body);
  return card;
}

function renderResults(tabId, items) {
  const container = document.getElementById(tabId + '-results');
  if (!container) return;
  container.innerHTML = '';
  if (state[tabId]) state[tabId].results = items;
  items.forEach(function (it) {
    container.appendChild(
      createResultCard(it.title, it.meta, it.blob, it.filename, it.single)
    );
  });
}

function createPreviewCard(title, imageSrc, meta) {
  const card = document.createElement('div');
  card.className = 'preview-card result-card';
  const imgWrap = document.createElement('div');
  imgWrap.className = 'result-img-wrap';
  const img = document.createElement('img');
  img.src = imageSrc;
  img.alt = title;
  imgWrap.appendChild(img);

  const body = document.createElement('div');
  body.className = 'result-body';
  body.innerHTML =
    '<div class="result-title">' + escapeHtml(title) + '</div>' +
    '<div class="result-meta">' + escapeHtml(meta) + '</div>';

  card.appendChild(imgWrap);
  card.appendChild(body);
  return card;
}

function validateImageFile(file) {
  const maxBytes = MAX_IMAGE_SIZE_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(file.name + ' 용량이 너무 큽니다. (최대 ' + MAX_IMAGE_SIZE_MB + 'MB)');
  }
}

function validatePdfFile(file) {
  const maxBytes = MAX_PDF_SIZE_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error('PDF 용량이 너무 큽니다. (최대 ' + MAX_PDF_SIZE_MB + 'MB)');
  }
  const ext = getExt(file.name);
  if (ext !== 'pdf' && file.type !== 'application/pdf') {
    throw new Error('PDF 파일만 선택해 주세요.');
  }
}

function setupDropZone(tabId, inputId, onFiles) {
  const zone = document.querySelector('.drop-zone[data-drop="' + tabId + '"]');
  const input = document.getElementById(inputId);
  if (!zone || !input) return;

  zone.addEventListener('click', function (e) {
    if (e.target.tagName !== 'INPUT' && !e.target.closest('button')) {
      input.click();
    }
  });

  const trigger = zone.querySelector('[data-trigger="' + inputId + '"]');
  if (trigger) {
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      input.click();
    });
  }

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
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      onFiles(Array.from(e.dataTransfer.files));
    }
  });

  input.addEventListener('change', function () {
    if (input.files && input.files.length) {
      onFiles(Array.from(input.files));
    }
    input.value = '';
  });
}

function setupReset(tabId, runBtnId, onReset) {
  const btn = document.getElementById(tabId + '-reset');
  const runBtn = document.getElementById(runBtnId);
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (state[tabId]) {
      if (state[tabId].files) state[tabId].files = [];
      if (state[tabId].items) state[tabId].items = [];
      if (state[tabId].results) state[tabId].results = [];
    }
    clearResults(tabId);
    showFileInfo(tabId, []);
    setStatus(tabId, '');
    setProgress(tabId, -1);
    if (runBtn) runBtn.disabled = true;
    const batch = document.getElementById(tabId + '-batch');
    if (batch) batch.classList.add('hidden');
    if (typeof onReset === 'function') onReset();
  });
}

// ─── Tab Switching ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const targetTab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.remove('active');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const panel = document.getElementById(targetTab);
    if (panel) panel.classList.add('active');
  });
});

// ─── Theme Toggle (Dark Mode) ──────────────────────────────────
function initTheme() {
  const toggleBtn = document.getElementById('theme-toggle');
  if (!toggleBtn) return;
  const saved = localStorage.getItem('theme-mode');
  if (saved === 'dark') {
    document.body.classList.add('dark-theme');
    toggleBtn.textContent = '☀️ 라이트 모드';
  } else {
    toggleBtn.textContent = '🌓 다크 모드';
  }

  toggleBtn.addEventListener('click', function () {
    const isDark = document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme-mode', isDark ? 'dark' : 'light');
    toggleBtn.textContent = isDark ? '☀️ 라이트 모드' : '🌓 다크 모드';
  });
}

// ─── Feature 1: Gallery (Local PC, Folder, Google Drive) ───────
function initGallery() {
  const grid = document.getElementById('gallery-grid');
  const toolbar = document.getElementById('gallery-toolbar');
  const countEl = document.getElementById('gallery-count');
  const viewer = document.getElementById('gallery-viewer');
  const viewerImg = document.getElementById('gallery-viewer-img');
  const viewerCounter = document.getElementById('gallery-viewer-counter');
  const viewerName = document.getElementById('gallery-viewer-name');
  const filmstrip = document.getElementById('gallery-viewer-filmstrip');
  const addBtn = document.getElementById('gallery-add-btn');
  let touchStartX = 0;
  let touchStartY = 0;

  function revokeGalleryItems(items) {
    items.forEach(function (item) {
      if (item.url && item.url.startsWith('blob:')) {
        URL.revokeObjectURL(item.url);
      }
    });
  }

  function sortGalleryItems(items, mode) {
    const sorted = items.slice();
    if (mode === 'name') {
      sorted.sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
    } else if (mode === 'size') {
      sorted.sort(function (a, b) {
        return b.size - a.size;
      });
    } else {
      sorted.sort(function (a, b) {
        return (b.modified || 0) - (a.modified || 0);
      });
    }
    return sorted;
  }

  function getSortMode() {
    return document.getElementById('gallery-sort').value;
  }

  function getSortedItems() {
    return sortGalleryItems(state.gallery.items, getSortMode());
  }

  function updateToolbar() {
    const n = state.gallery.items.length;
    if (n > 0) {
      toolbar.classList.remove('hidden');
      countEl.textContent = n + '장';
      addBtn.disabled = false;
    } else {
      toolbar.classList.add('hidden');
      addBtn.disabled = true;
    }
  }

  function renderGrid() {
    grid.innerHTML = '';
    const items = getSortedItems();
    items.forEach(function (item, idx) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gallery-thumb';
      btn.setAttribute('aria-label', item.name);

      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.name;
      img.loading = 'lazy';

      const badge = document.createElement('span');
      badge.className = 'gallery-thumb-index';
      badge.textContent = String(idx + 1);

      btn.appendChild(img);
      btn.appendChild(badge);
      btn.addEventListener('click', function () {
        openViewer(idx);
      });
      grid.appendChild(btn);
    });
    updateToolbar();
  }

  function updateViewer() {
    const items = getSortedItems();
    const total = items.length;
    if (total === 0) return;

    if (state.gallery.currentIndex >= total) {
      state.gallery.currentIndex = total - 1;
    }
    if (state.gallery.currentIndex < 0) state.gallery.currentIndex = 0;

    const item = items[state.gallery.currentIndex];
    viewerImg.src = item.url;
    viewerImg.alt = item.name;
    viewerCounter.textContent = state.gallery.currentIndex + 1 + ' / ' + total;
    viewerName.textContent = item.name + ' · ' + formatSize(item.size);

    filmstrip.innerHTML = '';
    items.forEach(function (it, i) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'viewer-film-thumb' + (i === state.gallery.currentIndex ? ' active' : '');
      const thumb = document.createElement('img');
      thumb.src = it.url;
      thumb.alt = '';
      btn.appendChild(thumb);
      btn.addEventListener('click', function () {
        state.gallery.currentIndex = i;
        updateViewer();
      });
      filmstrip.appendChild(btn);
    });

    const activeThumb = filmstrip.querySelector('.viewer-film-thumb.active');
    if (activeThumb) {
      activeThumb.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  }

  function openViewer(index) {
    if (state.gallery.items.length === 0) return;
    state.gallery.currentIndex = index;
    viewer.classList.remove('hidden');
    document.body.classList.add('viewer-open');
    updateViewer();
  }

  function closeViewer() {
    viewer.classList.add('hidden');
    document.body.classList.remove('viewer-open');
    viewerImg.src = '';
  }

  function viewerNext() {
    const total = getSortedItems().length;
    if (total === 0) return;
    state.gallery.currentIndex = (state.gallery.currentIndex + 1) % total;
    updateViewer();
  }

  function viewerPrev() {
    const total = getSortedItems().length;
    if (total === 0) return;
    state.gallery.currentIndex = (state.gallery.currentIndex - 1 + total) % total;
    updateViewer();
  }

  async function addGalleryFiles(files, append) {
    if (!files || !files.length) return;
    setLoading('gallery', true);
    let warnMsg = '';

    try {
      if (!append) {
        revokeGalleryItems(state.gallery.items);
        state.gallery.items = [];
      }

      const remaining = MAX_GALLERY_PHOTOS - state.gallery.items.length;
      let toAdd = Array.from(files).filter(function (f) {
        const type = f.type || '';
        const name = (f.name || '').toLowerCase();
        return (
          type.startsWith('image/') ||
          /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(name)
        );
      });

      if (toAdd.length === 0) {
        throw new Error('불러올 수 있는 이미지 파일이 없습니다.');
      }

      if (toAdd.length > remaining) {
        toAdd = toAdd.slice(0, remaining);
        warnMsg = '최대 ' + MAX_GALLERY_PHOTOS + '장 한도로 ' + remaining + '장만 추가했습니다.';
      }

      for (let i = 0; i < toAdd.length; i++) {
        if (i % 10 === 0) await yieldToMain();
        const file = toAdd[i];
        state.gallery.items.push({
          id: Date.now() + '-' + i + '-' + Math.random().toString(36).slice(2),
          file: file,
          url: URL.createObjectURL(file),
          name: file.name,
          size: file.size,
          modified: file.lastModified || 0
        });
      }

      renderGrid();
      const msg = state.gallery.items.length + '장 불러옴.' + (warnMsg ? ' ' + warnMsg : '');
      setStatus('gallery', msg, warnMsg ? 'warning' : 'success');
    } catch (err) {
      setStatus('gallery', err.message, 'error');
    } finally {
      setLoading('gallery', false);
    }
  }

  function clearGallery() {
    revokeGalleryItems(state.gallery.items);
    state.gallery.items = [];
    state.gallery.currentIndex = 0;
    grid.innerHTML = '';
    closeViewer();
    updateToolbar();
    setStatus('gallery', '');
  }

  // 1) 기본 파일 선택
  setupDropZone('gallery', 'gallery-input', function (files) {
    addGalleryFiles(files, false);
  });

  document.getElementById('gallery-files-btn').addEventListener('click', function () {
    document.getElementById('gallery-input').click();
  });

  // 2) 내 컴퓨터 폴더 통째로 열기
  const folderInput = document.getElementById('gallery-folder-input');
  document.getElementById('gallery-folder-btn').addEventListener('click', async function () {
    // 모던 File System Access API 지원 시 시도
    if (window.showDirectoryPicker && !isIOS()) {
      try {
        const dirHandle = await window.showDirectoryPicker();
        setLoading('gallery', true);
        const files = [];
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'file') {
            const file = await entry.getFile();
            if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.name)) {
              files.push(file);
            }
          }
        }
        if (files.length) {
          addGalleryFiles(files, false);
        } else {
          setStatus('gallery', '선택한 폴더에 이미지 파일이 없습니다.', 'warning');
        }
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      } finally {
        setLoading('gallery', false);
      }
    }
    // 폴백: <input webkitdirectory>
    folderInput.click();
  });

  folderInput.addEventListener('change', function () {
    if (this.files.length) addGalleryFiles(Array.from(this.files), false);
    this.value = '';
  });

  // 3) 사진 더 추가
  document.getElementById('gallery-add-btn').addEventListener('click', function () {
    document.getElementById('gallery-add-input').click();
  });

  document.getElementById('gallery-add-input').addEventListener('change', function () {
    if (this.files.length) addGalleryFiles(Array.from(this.files), true);
    this.value = '';
  });

  // 4) 정렬 변경
  document.getElementById('gallery-sort').addEventListener('change', function () {
    if (state.gallery.items.length) {
      renderGrid();
      if (!viewer.classList.contains('hidden')) {
        updateViewer();
      }
    }
  });

  // 5) 슬라이드 보기 & 전체 ZIP
  document.getElementById('gallery-slideshow-btn').addEventListener('click', function () {
    if (state.gallery.items.length === 0) {
      setStatus('gallery', '먼저 사진을 불러와 주세요.', 'warning');
      return;
    }
    openViewer(0);
  });

  document.getElementById('gallery-zip-btn').addEventListener('click', async function () {
    if (!state.gallery.items.length) return;
    try {
      setStatus('gallery', 'ZIP 생성 중...', 'info');
      const zipItems = state.gallery.items.map(function (it) {
        return { filename: it.name, blob: it.file };
      });
      await downloadZip(zipItems, 'gallery_photos.zip');
      setStatus('gallery', '전체 사진 ZIP 다운로드 완료!', 'success');
    } catch (err) {
      setStatus('gallery', 'ZIP 다운로드 실패: ' + err.message, 'error');
    }
  });

  document.getElementById('gallery-reset').addEventListener('click', clearGallery);
  document.getElementById('gallery-viewer-close').addEventListener('click', closeViewer);
  document.getElementById('gallery-viewer-prev').addEventListener('click', viewerPrev);
  document.getElementById('gallery-viewer-next').addEventListener('click', viewerNext);

  document.getElementById('gallery-viewer-save').addEventListener('click', async function () {
    const items = getSortedItems();
    const item = items[state.gallery.currentIndex];
    if (!item) return;
    try {
      await downloadBlob(item.file, item.name);
      setStatus('gallery', '저장/공유를 시도했습니다.', 'info');
    } catch (err) {
      setStatus('gallery', err.message, 'error');
    }
  });

  const stage = document.getElementById('gallery-viewer-stage');
  stage.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
  }, { passive: true });

  stage.addEventListener('touchend', function (e) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) viewerNext();
      else viewerPrev();
    }
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (viewer.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowRight') viewerNext();
    if (e.key === 'ArrowLeft') viewerPrev();
  });

  // 6) 구글 드라이브 모달 연동
  initGoogleDriveModal(addGalleryFiles);
}

// ─── Google Drive Modal & Direct Picker Integration ───────────
let gdriveAccessToken = null;
let gdriveTokenExpiresAt = 0;

function openGooglePicker(clientId, apiKey, onAddFiles) {
  if (typeof google === 'undefined' || !google.accounts || typeof gapi === 'undefined') {
    alert('Google API 클라이언트 라이브러리가 아직 로드되지 않았습니다. 잠시 후 다시 시도해 주세요.');
    return;
  }

  function launchPicker(token) {
    gapi.load('picker', function () {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS_IMAGES);
      view.setMimeTypes('image/png,image/jpeg,image/webp,image/gif,image/heic,image/bmp');

      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setCallback(async function (data) {
          if (data.action === google.picker.Action.PICKED) {
            setLoading('gallery', true);
            setStatus('gallery', '구글 드라이브에서 사진을 다운로드하는 중...', 'info');
            const files = [];
            for (let i = 0; i < data.docs.length; i++) {
              const doc = data.docs[i];
              try {
                const res = await fetch(
                  'https://www.googleapis.com/drive/v3/files/' + doc.id + '?alt=media',
                  { headers: { Authorization: 'Bearer ' + token } }
                );
                if (!res.ok) throw new Error('다운로드 실패');
                const blob = await res.blob();
                files.push(new File([blob], doc.name, { type: doc.mimeType || 'image/jpeg' }));
              } catch (e) {
                console.error('File download error:', e);
              }
            }
            setLoading('gallery', false);
            if (files.length) {
              onAddFiles(files, true);
              setStatus('gallery', files.length + '장의 구글 드라이브 사진을 불러왔습니다!', 'success');
            } else {
              setStatus('gallery', '구글 드라이브 사진을 가져오지 못했습니다.', 'error');
            }
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  // 기존 유효 토큰이 있다면 바로 팝업 없이 피커 실행!
  const now = Date.now();
  if (gdriveAccessToken && now < gdriveTokenExpiresAt) {
    launchPicker(gdriveAccessToken);
    return;
  }

  // 새 토큰 요청 (이미 권한 허용한 경우 자동 승인)
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    callback: function (response) {
      if (response.error !== undefined) {
        alert('Google 로그인 인증 실패: ' + response.error + '\n설정 정보를 확인해 주세요.');
        document.getElementById('gdrive-modal').classList.remove('hidden');
        return;
      }
      gdriveAccessToken = response.access_token;
      gdriveTokenExpiresAt = Date.now() + ((response.expires_in || 3600) - 100) * 1000;
      launchPicker(gdriveAccessToken);
    }
  });

  tokenClient.requestAccessToken({ prompt: '' });
}

function initGoogleDriveModal(onAddFiles) {
  const modal = document.getElementById('gdrive-modal');
  const openBtn = document.getElementById('gallery-gdrive-btn');
  const configBtn = document.getElementById('gallery-gdrive-config-btn');
  const closeBtn = document.getElementById('gdrive-modal-close');
  const fetchBtn = document.getElementById('gdrive-fetch-btn');
  const urlInput = document.getElementById('gdrive-share-url');
  const linkStatus = document.getElementById('gdrive-link-status');
  const pickerBtn = document.getElementById('gdrive-picker-btn');
  const clearBtn = document.getElementById('gdrive-clear-btn');

  function populateSavedKeys() {
    const savedClientId = localStorage.getItem('gdrive_client_id');
    const savedApiKey = localStorage.getItem('gdrive_api_key');
    if (savedClientId) document.getElementById('gdrive-client-id').value = savedClientId;
    if (savedApiKey) document.getElementById('gdrive-api-key').value = savedApiKey;
  }

  // 1) 구글 드라이브 메인 버튼: 이미 키가 저장되어 있으면 모달 없이 바로 내 드라이브 파일 탐색기 실행!
  openBtn.addEventListener('click', function () {
    const savedClientId = localStorage.getItem('gdrive_client_id');
    const savedApiKey = localStorage.getItem('gdrive_api_key');

    if (savedClientId && savedApiKey) {
      openGooglePicker(savedClientId, savedApiKey, onAddFiles);
    } else {
      // 처음이라 키가 없으면 설정 모달 열기
      populateSavedKeys();
      modal.classList.remove('hidden');
    }
  });

  // 2) 설정 키 변경 버튼: 언제든 모달을 열어 키를 수정하거나 공유 링크 사용 가능
  if (configBtn) {
    configBtn.addEventListener('click', function () {
      populateSavedKeys();
      modal.classList.remove('hidden');
    });
  }

  closeBtn.addEventListener('click', function () {
    modal.classList.add('hidden');
    linkStatus.textContent = '';
  });

  modal.addEventListener('click', function (e) {
    if (e.target === modal) {
      modal.classList.add('hidden');
      linkStatus.textContent = '';
    }
  });

  // 저장된 키 삭제
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      localStorage.removeItem('gdrive_client_id');
      localStorage.removeItem('gdrive_api_key');
      gdriveAccessToken = null;
      gdriveTokenExpiresAt = 0;
      document.getElementById('gdrive-client-id').value = '';
      document.getElementById('gdrive-api-key').value = '';
      alert('저장된 구글 드라이브 Client ID와 API Key가 삭제되었습니다.');
    });
  }

  // 방법 1: 공유 링크로 사진 가져오기
  fetchBtn.addEventListener('click', async function () {
    const url = urlInput.value.trim();
    if (!url) {
      linkStatus.textContent = '구글 드라이브 링크를 입력해 주세요.';
      linkStatus.className = 'status error';
      return;
    }

    let fileId = null;
    const m1 = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m1) fileId = m1[1];
    else if (m2) fileId = m2[1];

    if (!fileId) {
      linkStatus.textContent = '올바른 구글 드라이브 공유 링크 형식이 아닙니다.';
      linkStatus.className = 'status error';
      return;
    }

    linkStatus.textContent = '구글 드라이브에서 사진을 다운로드하는 중...';
    linkStatus.className = 'status info';

    const directUrl = 'https://lh3.googleusercontent.com/d/' + fileId;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(function (blob) {
          if (blob) {
            const file = new File([blob], 'gdrive_' + fileId.slice(0, 8) + '.jpg', {
              type: 'image/jpeg'
            });
            onAddFiles([file], true);
            linkStatus.textContent = '사진을 성공적으로 불러왔습니다!';
            linkStatus.className = 'status success';
            setTimeout(function () {
              modal.classList.add('hidden');
              urlInput.value = '';
              linkStatus.textContent = '';
            }, 1200);
          } else {
            linkStatus.textContent = '이미지 변환에 실패했습니다. 공개 권한을 확인하세요.';
            linkStatus.className = 'status error';
          }
        }, 'image/jpeg', 0.95);
      };
      img.onerror = function () {
        fetch('https://drive.google.com/uc?export=download&id=' + fileId)
          .then(function (res) {
            if (!res.ok) throw new Error('파일 다운로드 응답 실패');
            return res.blob();
          })
          .then(function (blob) {
            const file = new File([blob], 'gdrive_' + fileId.slice(0, 8) + '.jpg', {
              type: blob.type || 'image/jpeg'
            });
            onAddFiles([file], true);
            linkStatus.textContent = '사진을 성공적으로 불러왔습니다!';
            linkStatus.className = 'status success';
            setTimeout(function () {
              modal.classList.add('hidden');
              urlInput.value = '';
              linkStatus.textContent = '';
            }, 1200);
          })
          .catch(function () {
            linkStatus.textContent = '구글 드라이브 사진을 가져오지 못했습니다. 링크 공유 설정이 "링크가 있는 모든 사용자에게 공개"로 되어 있는지 확인해 주세요.';
            linkStatus.className = 'status error';
          });
      };
      img.src = directUrl;
    } catch (err) {
      linkStatus.textContent = '오류: ' + err.message;
      linkStatus.className = 'status error';
    }
  });

  // 방법 2: Google Picker 키 저장 후 즉시 실행!
  pickerBtn.addEventListener('click', function () {
    const clientId = document.getElementById('gdrive-client-id').value.trim();
    const apiKey = document.getElementById('gdrive-api-key').value.trim();

    if (!clientId || !apiKey) {
      alert('Google Client ID와 API Key를 모두 입력해야 내 드라이브 파일 탐색기를 열 수 있습니다.');
      return;
    }

    localStorage.setItem('gdrive_client_id', clientId);
    localStorage.setItem('gdrive_api_key', apiKey);
    modal.classList.add('hidden');

    openGooglePicker(clientId, apiKey, onAddFiles);
  });
}

// ─── Feature 2: PDF → JPG (with Page Range) ────────────────────
function parsePageRange(rangeStr, totalPages) {
  if (!rangeStr || !rangeStr.trim()) {
    const all = [];
    for (let i = 1; i <= totalPages; i++) all.push(i);
    return all;
  }
  const pages = new Set();
  const parts = rangeStr.split(',');
  parts.forEach(function (part) {
    const p = part.trim();
    if (p.includes('-')) {
      const sides = p.split('-');
      const start = parseInt(sides[0], 10);
      const end = parseInt(sides[1], 10);
      if (!isNaN(start) && !isNaN(end)) {
        const min = Math.max(1, Math.min(start, end));
        const max = Math.min(totalPages, Math.max(start, end));
        for (let i = min; i <= max; i++) pages.add(i);
      }
    } else {
      const num = parseInt(p, 10);
      if (!isNaN(num) && num >= 1 && num <= totalPages) {
        pages.add(num);
      }
    }
  });
  return Array.from(pages).sort(function (a, b) { return a - b; });
}

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
    const rangeInput = document.getElementById('pdf-jpg-range').value;
    const baseName = getBaseName(file.name);

    runBtn.disabled = true;
    setLoading('pdf-jpg', true);
    clearResults('pdf-jpg');
    setProgress('pdf-jpg', 0);
    setStatus('pdf-jpg', 'PDF 문서를 분석하는 중...', 'info');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const total = pdf.numPages;

      const targetPages = parsePageRange(rangeInput, total);
      if (targetPages.length === 0) {
        throw new Error('선택된 범위에 유효한 페이지가 없습니다. (전체 페이지: ' + total + ')');
      }

      const items = [];
      for (let idx = 0; idx < targetPages.length; idx++) {
        await yieldToMain();
        const pageNum = targetPages[idx];
        const pct = Math.round(((idx + 1) / targetPages.length) * 100);
        setProgress('pdf-jpg', pct);
        setStatus('pdf-jpg', '페이지 변환 중... (' + pageNum + '/' + total + ')', 'info');

        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
        checkCanvasLimits(Math.floor(viewport.width), Math.floor(viewport.height), 'pdf');

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        const filename = baseName + '_page_' + pageNum + '.jpg';
        items.push({
          title: '페이지 ' + pageNum,
          meta: formatSize(blob.size) + ' · ' + canvas.width + '×' + canvas.height + 'px',
          blob: blob,
          filename: filename
        });
      }

      renderResults('pdf-jpg', items);
      document.getElementById('pdf-jpg-batch').classList.remove('hidden');
      setProgress('pdf-jpg', 100);
      setStatus('pdf-jpg', targetPages.length + '개 페이지 변환 완료!', 'success');
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
    try {
      setStatus('pdf-jpg', 'ZIP 파일 생성 중...', 'info');
      const baseName = getBaseName(state['pdf-jpg'].files[0].name);
      await downloadZip(items, baseName + '_pages.zip');
      setStatus('pdf-jpg', 'ZIP 다운로드 완료!', 'success');
    } catch (err) {
      setStatus('pdf-jpg', 'ZIP 생성 실패: ' + err.message, 'error');
    }
  });
}

// ─── Feature 3: Image → PDF (Images to Multi-page PDF) ────────
function initImgPdf() {
  const runBtn = document.getElementById('img-pdf-run');
  const reorderWrap = document.getElementById('img-pdf-reorder-wrap');
  const countSpan = document.getElementById('img-pdf-count');
  const listEl = document.getElementById('img-pdf-list');

  function renderReorderList() {
    listEl.innerHTML = '';
    const items = state['img-pdf'].items;
    countSpan.textContent = String(items.length);

    if (items.length > 0) {
      reorderWrap.classList.remove('hidden');
      runBtn.disabled = false;
    } else {
      reorderWrap.classList.add('hidden');
      runBtn.disabled = true;
      return;
    }

    items.forEach(function (it, idx) {
      const row = document.createElement('div');
      row.className = 'reorder-item';
      row.draggable = true;

      const info = document.createElement('div');
      info.className = 'reorder-info';
      const thumb = document.createElement('img');
      thumb.className = 'reorder-thumb';
      thumb.src = it.url;
      thumb.alt = '';

      const text = document.createElement('div');
      text.innerHTML =
        '<div class="reorder-name"><strong>#' + (idx + 1) + '</strong> ' + escapeHtml(it.file.name) + '</div>' +
        '<div class="reorder-meta">' + formatSize(it.file.size) + '</div>';

      info.appendChild(thumb);
      info.appendChild(text);

      const acts = document.createElement('div');
      acts.className = 'reorder-actions';

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'reorder-btn';
      upBtn.textContent = '▲';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', function () {
        const tmp = items[idx];
        items[idx] = items[idx - 1];
        items[idx - 1] = tmp;
        renderReorderList();
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'reorder-btn';
      downBtn.textContent = '▼';
      downBtn.disabled = idx === items.length - 1;
      downBtn.addEventListener('click', function () {
        const tmp = items[idx];
        items[idx] = items[idx + 1];
        items[idx + 1] = tmp;
        renderReorderList();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'reorder-btn reorder-btn-del';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', function () {
        URL.revokeObjectURL(it.url);
        items.splice(idx, 1);
        renderReorderList();
      });

      acts.appendChild(upBtn);
      acts.appendChild(downBtn);
      acts.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(acts);
      listEl.appendChild(row);
    });
  }

  setupDropZone('img-pdf', 'img-pdf-input', function (files) {
    try {
      files.forEach(validateImageFile);
      files.forEach(function (f) {
        state['img-pdf'].items.push({
          file: f,
          url: URL.createObjectURL(f)
        });
      });
      renderReorderList();
      clearResults('img-pdf');
      setStatus('img-pdf', state['img-pdf'].items.length + '개 이미지 등록됨. 순서를 정렬하고 생성하세요.', 'info');
    } catch (err) {
      setStatus('img-pdf', err.message, 'error');
    }
  });

  setupReset('img-pdf', 'img-pdf-run', function () {
    state['img-pdf'].items.forEach(function (it) {
      URL.revokeObjectURL(it.url);
    });
    state['img-pdf'].items = [];
    renderReorderList();
  });

  runBtn.addEventListener('click', async function () {
    const items = state['img-pdf'].items;
    if (!items.length) return;

    if (typeof window.jspdf === 'undefined') {
      setStatus('img-pdf', 'jsPDF 라이브러리를 불러오지 못했습니다.', 'error');
      return;
    }

    runBtn.disabled = true;
    setLoading('img-pdf', true);
    clearResults('img-pdf');
    setStatus('img-pdf', 'PDF 문서 생성 중...', 'info');

    try {
      const { jsPDF } = window.jspdf;
      const sizeOpt = document.getElementById('img-pdf-size').value;
      const orientOpt = document.getElementById('img-pdf-orientation').value;
      const marginMm = parseInt(document.getElementById('img-pdf-margin').value, 10) || 0;

      let doc = null;

      for (let i = 0; i < items.length; i++) {
        await yieldToMain();
        setStatus('img-pdf', '이미지 처리 중 (' + (i + 1) + '/' + items.length + ')...', 'info');

        const it = items[i];
        const img = await loadImageFromFile(it.file);
        const imgW = img.naturalWidth;
        const imgH = img.naturalHeight;

        // 방향 판별
        let pageOrient = orientOpt === 'auto' ? (imgW > imgH ? 'l' : 'p') : orientOpt;

        // PDF 객체 생성 또는 페이지 추가
        if (i === 0) {
          if (sizeOpt === 'fit') {
            doc = new jsPDF({
              orientation: imgW > imgH ? 'landscape' : 'portrait',
              unit: 'px',
              format: [imgW, imgH]
            });
          } else {
            doc = new jsPDF({
              orientation: pageOrient,
              unit: 'mm',
              format: sizeOpt
            });
          }
        } else {
          if (sizeOpt === 'fit') {
            doc.addPage([imgW, imgH], imgW > imgH ? 'landscape' : 'portrait');
          } else {
            doc.addPage(sizeOpt, pageOrient);
          }
        }

        // 페이지 크기 계산
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();

        let renderX, renderY, renderW, renderH;

        if (sizeOpt === 'fit') {
          renderX = 0;
          renderY = 0;
          renderW = pageWidth;
          renderH = pageHeight;
        } else {
          const availW = Math.max(10, pageWidth - marginMm * 2);
          const availH = Math.max(10, pageHeight - marginMm * 2);
          const ratio = Math.min(availW / imgW, availH / imgH);
          renderW = imgW * ratio;
          renderH = imgH * ratio;
          renderX = (pageWidth - renderW) / 2;
          renderY = (pageHeight - renderH) / 2;
        }

        // 캔버스를 거쳐 확실한 JPEG 데이터 추출
        const canvas = document.createElement('canvas');
        canvas.width = imgW;
        canvas.height = imgH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, imgW, imgH);
        ctx.drawImage(img, 0, 0);

        const imgData = canvas.toDataURL('image/jpeg', 0.92);
        doc.addImage(imgData, 'JPEG', renderX, renderY, renderW, renderH);
      }

      const pdfBlob = doc.output('blob');
      const filename = 'combined_images_' + Date.now() + '.pdf';

      renderResults('img-pdf', [
        {
          title: '생성된 PDF 문서',
          meta: items.length + '개 페이지 · ' + formatSize(pdfBlob.size),
          blob: pdfBlob,
          filename: filename,
          single: true
        }
      ]);

      setStatus('img-pdf', 'PDF 문서가 성공적으로 생성되었습니다!', 'success');
    } catch (err) {
      setStatus('img-pdf', err.message || 'PDF 생성 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('img-pdf', false);
      runBtn.disabled = false;
    }
  });
}

// ─── Feature 4: Image Resize (Custom %, px, target KB) ─────────
function initResize() {
  const runBtn = document.getElementById('resize-run');

  // 모드 변경에 따른 서브 옵션 표시
  document.querySelectorAll('input[name="resize-mode"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      const mode = document.querySelector('input[name="resize-mode"]:checked').value;
      document.getElementById('opt-preset').classList.toggle('hidden', mode !== 'preset');
      document.getElementById('opt-custom-pct').classList.toggle('hidden', mode !== 'custom-pct');
      document.getElementById('opt-dimension').classList.toggle('hidden', mode !== 'dimension');
      document.getElementById('opt-target-size').classList.toggle('hidden', mode !== 'target-size');
    });
  });

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

    const mode = document.querySelector('input[name="resize-mode"]:checked').value;
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
        let origW = img.naturalWidth;
        let origH = img.naturalHeight;
        let newW = origW;
        let newH = origH;
        let mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        let quality = 0.92;
        let metaLabel = '';

        if (mode === 'preset') {
          const scale = parseFloat(document.getElementById('resize-preset-val').value);
          newW = Math.max(1, Math.round(origW * scale));
          newH = Math.max(1, Math.round(origH * scale));
          metaLabel = Math.round(scale * 100) + '%';
        } else if (mode === 'custom-pct') {
          const pct = Math.max(1, Math.min(99, parseInt(document.getElementById('resize-custom-pct-val').value, 10) || 50));
          const scale = pct / 100;
          newW = Math.max(1, Math.round(origW * scale));
          newH = Math.max(1, Math.round(origH * scale));
          metaLabel = pct + '%';
        } else if (mode === 'dimension') {
          const dimType = document.getElementById('resize-dim-type').value;
          const targetPx = parseInt(document.getElementById('resize-dim-px').value, 10) || 1200;
          let scale = 1;
          if (dimType === 'width') scale = targetPx / origW;
          else if (dimType === 'height') scale = targetPx / origH;
          else scale = targetPx / Math.max(origW, origH);

          scale = Math.min(1.0, scale);
          newW = Math.max(1, Math.round(origW * scale));
          newH = Math.max(1, Math.round(origH * scale));
          metaLabel = newW + '×' + newH + 'px';
        } else if (mode === 'target-size') {
          // 목표 파일 용량에 맞춘 이진 탐색 압축
          const targetBytes = (parseInt(document.getElementById('resize-target-kb').value, 10) || 300) * 1024;
          mime = 'image/jpeg'; // 고용량 압축은 JPEG가 가장 효과적
          metaLabel = '목표 ' + Math.round(targetBytes / 1024) + 'KB';

          let low = 0.15;
          let high = 0.95;
          let bestBlob = null;
          let currentScale = 1.0;

          // 만약 원본 해상도가 너무 크면 1차 축소
          if (origW > 2500 || origH > 2500) {
            currentScale = 2500 / Math.max(origW, origH);
          }

          for (let attempt = 0; attempt < 3; attempt++) {
            newW = Math.max(1, Math.round(origW * currentScale));
            newH = Math.max(1, Math.round(origH * currentScale));
            const c = document.createElement('canvas');
            c.width = newW;
            c.height = newH;
            const cx = c.getContext('2d');
            cx.drawImage(img, 0, 0, newW, newH);

            // 퀄리티 바이너리 서치
            for (let k = 0; k < 5; k++) {
              const midQ = (low + high) / 2;
              const b = await canvasToBlob(c, 'image/jpeg', midQ);
              if (b.size <= targetBytes) {
                bestBlob = b;
                low = midQ;
              } else {
                high = midQ;
              }
            }

            if (bestBlob && bestBlob.size <= targetBytes * 1.1) {
              break;
            }
            // 퀄리티를 최대로 낮춰도 목표보다 크면 해상도 추가 축소
            currentScale *= 0.7;
            low = 0.2;
            high = 0.9;
          }

          if (bestBlob) {
            const base = getBaseName(file.name);
            items.push({
              title: base,
              meta: metaLabel + ' · ' + newW + '×' + newH + 'px · ' + formatSize(bestBlob.size),
              blob: bestBlob,
              filename: 'resized_' + base + '.jpg'
            });
            continue;
          }
        }

        checkCanvasLimits(newW, newH, 'resize');

        const out = document.createElement('canvas');
        out.width = newW;
        out.height = newH;
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, newW, newH);

        const ext = mime === 'image/png' ? 'png' : 'jpg';
        const blob = await canvasToBlob(out, mime, quality);
        const base = getBaseName(file.name);

        items.push({
          title: base,
          meta: metaLabel + ' · ' + newW + '×' + newH + 'px · ' + formatSize(blob.size),
          blob: blob,
          filename: 'resized_' + base + '.' + ext
        });
      }

      renderResults('resize', items);
      const batchEl = document.getElementById('resize-batch');
      if (items.length > 1) batchEl.classList.remove('hidden');
      else batchEl.classList.add('hidden');
      setStatus('resize', files.length + '개 이미지 축소 완료!' + (warnMsg ? ' ' + warnMsg : ''), 'success');
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
    try {
      setStatus('resize', 'ZIP 파일 생성 중...', 'info');
      await downloadZip(items, 'resized_images.zip');
      setStatus('resize', 'ZIP 다운로드 완료!', 'success');
    } catch (err) {
      setStatus('resize', 'ZIP 생성 실패: ' + err.message, 'error');
    }
  });
}

// ─── Feature 5: Format Converter & Lightweight Compression ────
function initConvert() {
  const runBtn = document.getElementById('convert-run');
  const qSlider = document.getElementById('convert-quality');
  const qVal = document.getElementById('convert-quality-val');

  qSlider.addEventListener('input', function () {
    qVal.textContent = qSlider.value + '%';
  });

  setupDropZone('convert', 'convert-input', function (files) {
    try {
      files.forEach(validateImageFile);
      state.convert.files = files;
      clearResults('convert');
      showFileInfo('convert', files);
      setStatus('convert', files.length + '개 이미지 선택됨. 포맷 및 품질을 설정하고 실행하세요.', 'info');
      runBtn.disabled = false;
    } catch (err) {
      setStatus('convert', err.message, 'error');
    }
  });

  setupReset('convert', 'convert-run', function () {
    document.getElementById('convert-batch').classList.add('hidden');
  });

  runBtn.addEventListener('click', async function () {
    const files = state.convert.files;
    if (!files.length) return;

    const format = document.getElementById('convert-format').value;
    const quality = parseInt(qSlider.value, 10) / 100;
    const ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';

    runBtn.disabled = true;
    setLoading('convert', true);
    clearResults('convert');

    const items = [];

    try {
      for (let i = 0; i < files.length; i++) {
        await yieldToMain();
        const file = files[i];
        setStatus('convert', '변환 및 압축 중... (' + (i + 1) + '/' + files.length + ')', 'info');

        const img = await loadImageFromFile(file);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');

        // PNG 투명 배경 처리
        if (format === 'image/jpeg') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0);

        // 캔버스 toBlob으로 다시 인코딩 -> EXIF 메타데이터가 완벽하게 제거됨!
        const blob = await canvasToBlob(canvas, format, format === 'image/png' ? undefined : quality);
        const origSize = file.size;
        const newSize = blob.size;
        const savingPct = Math.round(((origSize - newSize) / origSize) * 100);
        const diffText = savingPct > 0 ? ' (' + savingPct + '% 절감)' : '';

        const base = getBaseName(file.name);
        items.push({
          title: base + '.' + ext,
          meta: formatSize(origSize) + ' → ' + formatSize(newSize) + diffText,
          blob: blob,
          filename: base + '_converted.' + ext
        });
      }

      renderResults('convert', items);
      const batchEl = document.getElementById('convert-batch');
      if (items.length > 1) batchEl.classList.remove('hidden');
      else batchEl.classList.add('hidden');
      setStatus('convert', files.length + '개 이미지 변환 및 압축 완료! (EXIF 메타데이터 제거됨)', 'success');
    } catch (err) {
      setStatus('convert', err.message || '변환 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('convert', false);
      runBtn.disabled = false;
    }
  });

  document.getElementById('convert-zip').addEventListener('click', async function () {
    const items = state.convert.results;
    if (items.length < 2) return;
    try {
      setStatus('convert', 'ZIP 파일 생성 중...', 'info');
      await downloadZip(items, 'converted_images.zip');
      setStatus('convert', 'ZIP 다운로드 완료!', 'success');
    } catch (err) {
      setStatus('convert', 'ZIP 생성 실패: ' + err.message, 'error');
    }
  });
}

// ─── Feature 6: Image Upscale 2x ───────────────────────────────
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
        unsharpThreshold: 2
      });

      const blob = await canvasToBlob(destCanvas, format, quality);
      const base = getBaseName(file.name);

      renderResults('upscale', [
        {
          title: base + ' (2배)',
          meta: destW + '×' + destH + 'px · ' + formatSize(blob.size),
          blob: blob,
          filename: 'upscale_2x_' + base + '.' + ext,
          single: true
        }
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

// ─── Feature 7: Image Merge (Vertical / Horizontal + Reorder) ──
function initMerge() {
  const runBtn = document.getElementById('merge-run');
  const customWrap = document.getElementById('merge-custom-wrap');
  const customLabel = document.getElementById('merge-custom-label');
  const reorderWrap = document.getElementById('merge-reorder-wrap');
  const countSpan = document.getElementById('merge-count');
  const listEl = document.getElementById('merge-list');

  function renderMergeList() {
    listEl.innerHTML = '';
    const items = state.merge.items;
    countSpan.textContent = String(items.length);

    if (items.length >= 2) {
      reorderWrap.classList.remove('hidden');
      runBtn.disabled = false;
    } else {
      reorderWrap.classList.toggle('hidden', items.length === 0);
      runBtn.disabled = true;
    }

    items.forEach(function (it, idx) {
      const row = document.createElement('div');
      row.className = 'reorder-item';

      const info = document.createElement('div');
      info.className = 'reorder-info';
      const thumb = document.createElement('img');
      thumb.className = 'reorder-thumb';
      thumb.src = it.url;
      thumb.alt = '';

      const text = document.createElement('div');
      text.innerHTML =
        '<div class="reorder-name"><strong>#' + (idx + 1) + '</strong> ' + escapeHtml(it.file.name) + '</div>' +
        '<div class="reorder-meta">' + formatSize(it.file.size) + '</div>';

      info.appendChild(thumb);
      info.appendChild(text);

      const acts = document.createElement('div');
      acts.className = 'reorder-actions';

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'reorder-btn';
      upBtn.textContent = '▲';
      upBtn.disabled = idx === 0;
      upBtn.addEventListener('click', function () {
        const tmp = items[idx];
        items[idx] = items[idx - 1];
        items[idx - 1] = tmp;
        renderMergeList();
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'reorder-btn';
      downBtn.textContent = '▼';
      downBtn.disabled = idx === items.length - 1;
      downBtn.addEventListener('click', function () {
        const tmp = items[idx];
        items[idx] = items[idx + 1];
        items[idx + 1] = tmp;
        renderMergeList();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'reorder-btn reorder-btn-del';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', function () {
        URL.revokeObjectURL(it.url);
        items.splice(idx, 1);
        renderMergeList();
      });

      acts.appendChild(upBtn);
      acts.appendChild(downBtn);
      acts.appendChild(delBtn);

      row.appendChild(info);
      row.appendChild(acts);
      listEl.appendChild(row);
    });
  }

  document.querySelectorAll('input[name="merge-direction"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      const dir = document.querySelector('input[name="merge-direction"]:checked').value;
      customLabel.textContent = dir === 'vertical' ? '폭 (px)' : '높이 (px)';
    });
  });

  document.querySelectorAll('input[name="merge-width"]').forEach(function (radio) {
    radio.addEventListener('change', function () {
      const mode = document.querySelector('input[name="merge-width"]:checked').value;
      customWrap.classList.toggle('hidden', mode !== 'custom');
    });
  });

  setupDropZone('merge', 'merge-input', function (files) {
    try {
      files.forEach(validateImageFile);
      files.forEach(function (f) {
        state.merge.items.push({
          file: f,
          url: URL.createObjectURL(f)
        });
      });
      renderMergeList();
      clearResults('merge');
      setStatus('merge', state.merge.items.length + '개 이미지 등록됨. 순서를 확인하고 합치기를 실행하세요.', 'info');
    } catch (err) {
      setStatus('merge', err.message, 'error');
    }
  });

  setupReset('merge', 'merge-run', function () {
    state.merge.items.forEach(function (it) {
      URL.revokeObjectURL(it.url);
    });
    state.merge.items = [];
    renderMergeList();
  });

  runBtn.addEventListener('click', async function () {
    const items = state.merge.items;
    if (items.length < 2) return;

    const dir = document.querySelector('input[name="merge-direction"]:checked').value;
    const widthMode = document.querySelector('input[name="merge-width"]:checked').value;
    const format = document.getElementById('merge-format').value;
    const quality = parseFloat(document.getElementById('merge-quality').value);
    const ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';

    runBtn.disabled = true;
    setLoading('merge', true);
    clearResults('merge');
    setStatus('merge', '이미지 불러오는 중...', 'info');

    try {
      const images = [];
      for (let i = 0; i < items.length; i++) {
        const img = await loadImageFromFile(items[i].file);
        images.push(img);
      }

      let canvasW, canvasH;
      const scaled = [];

      if (dir === 'vertical') {
        // 세로로 이어붙이기 (너비 통일)
        let targetWidth;
        if (widthMode === 'first') {
          targetWidth = images[0].naturalWidth;
        } else if (widthMode === 'max') {
          targetWidth = Math.max.apply(null, images.map(function (im) { return im.naturalWidth; }));
        } else {
          targetWidth = parseInt(document.getElementById('merge-custom-width').value, 10) || 800;
        }

        images.forEach(function (img) {
          const ratio = targetWidth / img.naturalWidth;
          scaled.push({
            img: img,
            w: targetWidth,
            h: Math.round(img.naturalHeight * ratio)
          });
        });

        canvasW = targetWidth;
        canvasH = scaled.reduce(function (sum, s) { return sum + s.h; }, 0);
      } else {
        // 가로로 이어붙이기 (높이 통일)
        let targetHeight;
        if (widthMode === 'first') {
          targetHeight = images[0].naturalHeight;
        } else if (widthMode === 'max') {
          targetHeight = Math.max.apply(null, images.map(function (im) { return im.naturalHeight; }));
        } else {
          targetHeight = parseInt(document.getElementById('merge-custom-width').value, 10) || 800;
        }

        images.forEach(function (img) {
          const ratio = targetHeight / img.naturalHeight;
          scaled.push({
            img: img,
            w: Math.round(img.naturalWidth * ratio),
            h: targetHeight
          });
        });

        canvasH = targetHeight;
        canvasW = scaled.reduce(function (sum, s) { return sum + s.w; }, 0);
      }

      checkCanvasLimits(canvasW, canvasH, 'merge');

      const canvas = document.createElement('canvas');
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasW, canvasH);

      let offset = 0;
      for (let i = 0; i < scaled.length; i++) {
        await yieldToMain();
        setStatus('merge', '합치는 중... (' + (i + 1) + '/' + scaled.length + ')', 'info');
        if (dir === 'vertical') {
          ctx.drawImage(scaled[i].img, 0, offset, scaled[i].w, scaled[i].h);
          offset += scaled[i].h;
        } else {
          ctx.drawImage(scaled[i].img, offset, 0, scaled[i].w, scaled[i].h);
          offset += scaled[i].w;
        }
      }

      const blob = await canvasToBlob(canvas, format, format === 'image/png' ? undefined : quality);
      const filename = 'merged_' + (dir === 'vertical' ? 'v' : 'h') + '_' + Date.now() + '.' + ext;

      renderResults('merge', [
        {
          title: dir === 'vertical' ? '세로 합친 이미지' : '가로 합친 이미지',
          meta: canvasW + '×' + canvasH + 'px · ' + formatSize(blob.size),
          blob: blob,
          filename: filename,
          single: true
        }
      ]);

      setStatus('merge', '이미지 합치기 완료!', 'success');
    } catch (err) {
      setStatus('merge', err.message || '이미지 합치기 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('merge', false);
      runBtn.disabled = false;
    }
  });
}

// ─── Feature 8: Simple Image Editor (Rotate, Flip, Crop, Filter)
function initEditor() {
  const workspace = document.getElementById('edit-workspace');
  const editImg = document.getElementById('edit-image');
  const statusEl = document.getElementById('edit-status');
  const bSlider = document.getElementById('edit-brightness');
  const cSlider = document.getElementById('edit-contrast');
  const sSlider = document.getElementById('edit-saturate');
  const bVal = document.getElementById('edit-bright-val');
  const cVal = document.getElementById('edit-contrast-val');
  const sVal = document.getElementById('edit-saturate-val');
  const cropBtn = document.getElementById('edit-crop-btn');
  const cropApply = document.getElementById('edit-crop-apply');
  const cropCancel = document.getElementById('edit-crop-cancel');

  function updateTransformCss() {
    const rot = state.edit.rotation;
    const fh = state.edit.flipH;
    const fv = state.edit.flipV;
    const b = bSlider.value;
    const c = cSlider.value;
    const s = sSlider.value;

    bVal.textContent = b + '%';
    cVal.textContent = c + '%';
    sVal.textContent = s + '%';

    editImg.style.transform = 'rotate(' + rot + 'deg) scale(' + fh + ', ' + fv + ')';
    editImg.style.filter = 'brightness(' + b + '%) contrast(' + c + '%) saturate(' + s + '%)';
  }

  function destroyCropper() {
    if (state.edit.cropper) {
      state.edit.cropper.destroy();
      state.edit.cropper = null;
    }
    cropApply.classList.add('hidden');
    cropCancel.classList.add('hidden');
    cropBtn.classList.remove('hidden');
  }

  setupDropZone('edit', 'edit-input', async function (files) {
    try {
      if (!files.length) return;
      validateImageFile(files[0]);
      state.edit.file = files[0];
      destroyCropper();

      state.edit.rotation = 0;
      state.edit.flipH = 1;
      state.edit.flipV = 1;
      bSlider.value = 100;
      cSlider.value = 100;
      sSlider.value = 100;

      const img = await loadImageFromFile(files[0]);
      state.edit.img = img;
      editImg.src = img.src;
      updateTransformCss();
      workspace.classList.remove('hidden');
      showFileInfo('edit', [files[0]]);
      statusEl.textContent = '편집할 도구를 선택하세요.';
      statusEl.className = 'status info';
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status error';
    }
  });

  document.getElementById('edit-rot-cw').addEventListener('click', function () {
    destroyCropper();
    state.edit.rotation = (state.edit.rotation + 90) % 360;
    updateTransformCss();
  });

  document.getElementById('edit-rot-ccw').addEventListener('click', function () {
    destroyCropper();
    state.edit.rotation = (state.edit.rotation - 90 + 360) % 360;
    updateTransformCss();
  });

  document.getElementById('edit-flip-h').addEventListener('click', function () {
    destroyCropper();
    state.edit.flipH *= -1;
    updateTransformCss();
  });

  document.getElementById('edit-flip-v').addEventListener('click', function () {
    destroyCropper();
    state.edit.flipV *= -1;
    updateTransformCss();
  });

  [bSlider, cSlider, sSlider].forEach(function (sl) {
    sl.addEventListener('input', updateTransformCss);
  });

  document.getElementById('edit-reset-transforms').addEventListener('click', function () {
    destroyCropper();
    state.edit.rotation = 0;
    state.edit.flipH = 1;
    state.edit.flipV = 1;
    bSlider.value = 100;
    cSlider.value = 100;
    sSlider.value = 100;
    updateTransformCss();
  });

  cropBtn.addEventListener('click', function () {
    if (typeof Cropper === 'undefined') {
      alert('Cropper 라이브러리가 로드되지 않았습니다.');
      return;
    }
    destroyCropper();
    state.edit.cropper = new Cropper(editImg, {
      viewMode: 1,
      autoCropArea: 0.8,
      responsive: true
    });
    cropApply.classList.remove('hidden');
    cropCancel.classList.remove('hidden');
    cropBtn.classList.add('hidden');
  });

  cropCancel.addEventListener('click', destroyCropper);

  cropApply.addEventListener('click', function () {
    if (!state.edit.cropper) return;
    const croppedCanvas = state.edit.cropper.getCroppedCanvas();
    if (croppedCanvas) {
      editImg.src = croppedCanvas.toDataURL();
      state.edit.rotation = 0;
      state.edit.flipH = 1;
      state.edit.flipV = 1;
      updateTransformCss();
      statusEl.textContent = '선택 영역이 성공적으로 잘렸습니다.';
      statusEl.className = 'status success';
    }
    destroyCropper();
  });

  document.getElementById('edit-save-btn').addEventListener('click', async function () {
    if (!state.edit.file) return;
    destroyCropper();

    const format = document.getElementById('edit-format').value;
    const ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';

    statusEl.textContent = '편집 결과를 저장하는 중...';
    statusEl.className = 'status info';

    try {
      const curImg = new Image();
      curImg.src = editImg.src;
      await new Promise(function (res) { curImg.onload = res; });

      const rot = state.edit.rotation;
      const fh = state.edit.flipH;
      const fv = state.edit.flipV;
      const is90or270 = rot === 90 || rot === 270;

      const outW = is90or270 ? curImg.naturalHeight : curImg.naturalWidth;
      const outH = is90or270 ? curImg.naturalWidth : curImg.naturalHeight;

      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');

      // 필터 적용
      const b = bSlider.value;
      const c = cSlider.value;
      const s = sSlider.value;
      ctx.filter = 'brightness(' + b + '%) contrast(' + c + '%) saturate(' + s + '%)';

      ctx.save();
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.scale(fh, fv);
      ctx.drawImage(curImg, -curImg.naturalWidth / 2, -curImg.naturalHeight / 2);
      ctx.restore();

      const blob = await canvasToBlob(canvas, format, 0.92);
      const base = getBaseName(state.edit.file.name);
      await downloadBlob(blob, 'edited_' + base + '.' + ext);
      statusEl.textContent = '편집된 이미지가 성공적으로 저장되었습니다!';
      statusEl.className = 'status success';
    } catch (err) {
      statusEl.textContent = '저장 실패: ' + err.message;
      statusEl.className = 'status error';
    }
  });
}

// ─── Feature 9: Document Scan (OpenCV with Interactive Corners) 
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
    [100, 250, 0.015, 0.20]
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
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y
  ]);
  const dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, maxWidth - 1, 0, maxWidth - 1, maxHeight - 1, 0, maxHeight - 1
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

function updateScanButton() {
  const runBtn = document.getElementById('scan-run');
  if (!runBtn) return;
  const hasFile = state.scan.file !== null;
  runBtn.disabled = !hasFile || !window.opencvReady;
}

function initScan() {
  const runBtn = document.getElementById('scan-run');
  const cornerWrap = document.getElementById('scan-corner-wrap');
  const scanCanvas = document.getElementById('scan-canvas');
  const ctx = scanCanvas.getContext('2d');
  const cornerRadius = 18;

  function redrawCornerCanvas() {
    if (!state.scan.img || !state.scan.corners) return;
    const img = state.scan.img;
    const corners = state.scan.corners;
    const scale = state.scan.canvasScale;

    scanCanvas.width = img.naturalWidth * scale;
    scanCanvas.height = img.naturalHeight * scale;

    ctx.clearRect(0, 0, scanCanvas.width, scanCanvas.height);
    ctx.drawImage(img, 0, 0, scanCanvas.width, scanCanvas.height);

    // 사각형 영역 그리기
    ctx.beginPath();
    ctx.moveTo(corners[0].x * scale, corners[0].y * scale);
    ctx.lineTo(corners[1].x * scale, corners[1].y * scale);
    ctx.lineTo(corners[2].x * scale, corners[2].y * scale);
    ctx.lineTo(corners[3].x * scale, corners[3].y * scale);
    ctx.closePath();

    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = 'rgba(37, 99, 235, 0.2)';
    ctx.fill();

    // 4개 꼭짓점 핸들 그리기
    const cornerLabels = ['좌상단', '우상단', '우하단', '좌하단'];
    corners.forEach(function (pt, idx) {
      const px = pt.x * scale;
      const py = pt.y * scale;

      ctx.beginPath();
      ctx.arc(px, py, cornerRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = idx === state.scan.activeCornerIndex ? '#dc2626' : '#2563eb';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#2563eb';
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 4;
      ctx.fillText(cornerLabels[idx], px + 22, py + 5);
      ctx.shadowBlur = 0;
    });
  }

  function getEventCanvasCoords(e) {
    const rect = scanCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (scanCanvas.width / rect.width),
      y: (clientY - rect.top) * (scanCanvas.height / rect.height)
    };
  }

  function onPointerDown(e) {
    if (!state.scan.corners) return;
    const coords = getEventCanvasCoords(e);
    const scale = state.scan.canvasScale;

    let closestIdx = -1;
    let minD = cornerRadius * 2.5;

    state.scan.corners.forEach(function (pt, idx) {
      const d = Math.hypot(pt.x * scale - coords.x, pt.y * scale - coords.y);
      if (d < minD) {
        minD = d;
        closestIdx = idx;
      }
    });

    state.scan.activeCornerIndex = closestIdx;
    if (closestIdx !== -1) {
      e.preventDefault();
      redrawCornerCanvas();
    }
  }

  function onPointerMove(e) {
    if (state.scan.activeCornerIndex === -1 || !state.scan.corners) return;
    e.preventDefault();
    const coords = getEventCanvasCoords(e);
    const scale = state.scan.canvasScale;

    const imgW = state.scan.img.naturalWidth;
    const imgH = state.scan.img.naturalHeight;

    const newX = Math.max(0, Math.min(imgW, coords.x / scale));
    const newY = Math.max(0, Math.min(imgH, coords.y / scale));

    state.scan.corners[state.scan.activeCornerIndex] = { x: newX, y: newY };
    redrawCornerCanvas();
  }

  function onPointerUp() {
    state.scan.activeCornerIndex = -1;
    redrawCornerCanvas();
  }

  scanCanvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  scanCanvas.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('touchend', onPointerUp);

  async function handleScanFiles(files) {
    try {
      if (files.length > 1) throw new Error('문서 보정은 한 번에 하나의 이미지만 처리합니다.');
      validateImageFile(files[0]);
      state.scan.file = files[0];
      clearResults('scan');
      showFileInfo('scan', [files[0]]);
      setStatus('scan', '문서 모서리를 분석하는 중...', 'info');

      const img = await loadImageFromFile(files[0]);
      state.scan.img = img;

      // 캔버스 표시용 축소 스케일 계산
      const maxDisplaySide = 800;
      state.scan.canvasScale = Math.min(1.0, maxDisplaySide / Math.max(img.naturalWidth, img.naturalHeight));

      // OpenCV Mat 로드 및 코너 감지
      if (window.opencvReady) {
        const prep = imageFileToCanvas(img, SCAN_MAX_SIDE);
        const cvMat = cv.imread(prep.canvas);
        const detected = findDocumentCorners(cvMat);
        cvMat.delete();

        if (detected) {
          const ratio = img.naturalWidth / prep.canvas.width;
          state.scan.corners = detected.map(function (p) {
            return { x: p.x * ratio, y: p.y * ratio };
          });
          setStatus('scan', '문서 모서리가 감지되었습니다. 필요시 꼭짓점을 드래그하여 미세조정하세요.', 'success');
        } else {
          // 감지 실패 시 기본 여백 코너 설정
          state.scan.corners = [
            { x: img.naturalWidth * 0.05, y: img.naturalHeight * 0.05 },
            { x: img.naturalWidth * 0.95, y: img.naturalHeight * 0.05 },
            { x: img.naturalWidth * 0.95, y: img.naturalHeight * 0.95 },
            { x: img.naturalWidth * 0.05, y: img.naturalHeight * 0.95 }
          ];
          setStatus('scan', '모서리 자동 감지에 실패하여 기본 테두리를 설정했습니다. 꼭짓점을 드래그하여 맞추세요.', 'warning');
        }
      } else {
        state.scan.corners = [
          { x: 0, y: 0 },
          { x: img.naturalWidth, y: 0 },
          { x: img.naturalWidth, imgH: img.naturalHeight },
          { x: 0, y: img.naturalHeight }
        ];
      }

      cornerWrap.classList.remove('hidden');
      redrawCornerCanvas();
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

  document.getElementById('scan-detect-auto').addEventListener('click', function () {
    if (!state.scan.img || !window.opencvReady) return;
    const prep = imageFileToCanvas(state.scan.img, SCAN_MAX_SIDE);
    const cvMat = cv.imread(prep.canvas);
    const detected = findDocumentCorners(cvMat);
    cvMat.delete();
    if (detected) {
      const ratio = state.scan.img.naturalWidth / prep.canvas.width;
      state.scan.corners = detected.map(function (p) {
        return { x: p.x * ratio, y: p.y * ratio };
      });
      redrawCornerCanvas();
      setStatus('scan', '모서리를 다시 자동 감지했습니다.', 'success');
    } else {
      setStatus('scan', '모서리 감지 실패. 수동으로 드래그해 주세요.', 'warning');
    }
  });

  document.getElementById('scan-corner-full').addEventListener('click', function () {
    if (!state.scan.img) return;
    const w = state.scan.img.naturalWidth;
    const h = state.scan.img.naturalHeight;
    state.scan.corners = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h }
    ];
    redrawCornerCanvas();
  });

  setupReset('scan', 'scan-run', function () {
    state.scan.file = null;
    state.scan.img = null;
    state.scan.corners = null;
    cornerWrap.classList.add('hidden');
    updateScanButton();
  });

  runBtn.addEventListener('click', async function () {
    if (!state.scan.file || !state.scan.corners) return;

    if (!window.opencvReady) {
      setStatus('scan', 'OpenCV.js가 아직 준비되지 않았습니다.', 'error');
      return;
    }

    const mode = document.querySelector('input[name="scan-mode"]:checked').value;
    const quality = parseFloat(document.getElementById('scan-quality').value);

    runBtn.disabled = true;
    setLoading('scan', true);
    clearResults('scan');
    setStatus('scan', '문서 평면 보정 및 선명화 처리 중...', 'info');

    try {
      const img = state.scan.img;
      const prep = imageFileToCanvas(img, SCAN_MAX_SIDE);
      const ratio = prep.canvas.width / img.naturalWidth;
      const scaledCorners = state.scan.corners.map(function (pt) {
        return { x: pt.x * ratio, y: pt.y * ratio };
      });

      const srcMat = cv.imread(prep.canvas);
      let working = warpDocument(srcMat, scaledCorners);
      srcMat.delete();

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

      const blob = await matToBlob(result, quality);
      result.delete();

      const base = getBaseName(state.scan.file.name);
      const resultsEl = document.getElementById('scan-results');
      resultsEl.innerHTML = '';
      resultsEl.classList.add('compare');

      const origUrl = URL.createObjectURL(state.scan.file);
      resultsEl.appendChild(createPreviewCard('원본 사진', origUrl, state.scan.file.name));
      resultsEl.appendChild(createResultCard(
        '보정된 스캔 문서',
        (mode === 'bw' ? '흑백' : '컬러') + ' · ' + formatSize(blob.size),
        blob,
        'scanned_' + base + '.jpg',
        false
      ));

      setStatus('scan', '문서 보정 완료!', 'success');
    } catch (err) {
      setStatus('scan', err.message || '문서 보정 중 오류가 발생했습니다.', 'error');
    } finally {
      setLoading('scan', false);
      updateScanButton();
    }
  });
}

// ─── Application Initialization ────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  applyDeviceLimits();
  initTheme();
  initGallery();
  initPdfJpg();
  initImgPdf();
  initResize();
  initConvert();
  initUpscale();
  initMerge();
  initEditor();
  initScan();

  // Service Worker 등록 (오프라인 PWA)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').then(function (reg) {
        console.log('Service Worker registered:', reg.scope);
      }).catch(function (err) {
        console.warn('Service Worker registration failed:', err);
      });
    });
  }
});

window.addEventListener('resize', function () {
  if (window.innerWidth <= 600) document.body.classList.add('is-mobile');
  else document.body.classList.remove('is-mobile');
});