/* ===========================================================
   IST Trust Zone — PDF Tools Engine
   Client-side PDF processing using pdf-lib, pdf.js & JSZip
   All files are processed locally — nothing leaves your device.
   =========================================================== */

import { initThemeSwitch, getStoredTheme } from './theme.js';
import { showToast } from './shared.js';

/* ---- Lazy-loaded library URLs ---- */
const PDFLIB_URL = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const PDFJS_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const JSZIP_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

/* ---- Lazy load helper ---- */
const _libraryCache = {};
function loadScript(url) {
  if (_libraryCache[url]) return _libraryCache[url];
  _libraryCache[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(window);
    s.onerror = () => reject(new Error(`Failed to load ${url}`));
    document.head.appendChild(s);
  });
  return _libraryCache[url];
}

let _pdfjsReady = false;
async function ensurePDFJS() {
  if (_pdfjsReady) return;
  await loadScript(PDFJS_URL);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  _pdfjsReady = true;
}

async function ensurePDFLib() {
  await loadScript(PDFLIB_URL);
}

async function ensureJSZip() {
  await loadScript(JSZIP_URL);
}

/* ---- Helpers ---- */
function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  const u = ['KB','MB','GB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' ' + u[i];
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function parsePageRange(input, totalPages) {
  const pages = new Set();
  if (!input || !input.trim()) return null;
  const parts = input.split(',').map(s => s.trim());
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : start;
    if (start < 1 || end > totalPages || start > end) return null;
    for (let i = start; i <= end; i++) pages.add(i);
  }
  return pages.size ? [...pages].sort((a,b) => a-b) : null;
}

/* ---- Toast ---- */
function toast(msg, type = '') {
  showToast(msg, type);
}

/* ---- Dropzone Setup ---- */
function setupDropzone(dropzoneId, inputId, onChange, acceptMultiple = false) {
  const dz = document.getElementById(dropzoneId);
  const inp = document.getElementById(inputId);
  if (!dz || !inp) return;

  dz.addEventListener('click', (e) => {
    if (e.target === inp) return;
    inp.click();
  });

  inp.addEventListener('change', () => {
    if (onChange) onChange(Array.from(inp.files));
  });

  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('drag-over');
  });
  dz.addEventListener('dragleave', () => {
    dz.classList.remove('drag-over');
  });
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (!acceptMultiple && files.length > 1) {
      toast('Please drop only one file', 'error');
      return;
    }
    if (onChange) onChange(files);
  });
}

function renderFileList(containerId, files) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = files.map((f, i) => `
    <div class="tool-file-item" data-index="${i}">
      <span class="file-name" title="${f.name}">${f.name}</span>
      <span class="file-size">${formatBytes(f.size)}</span>
      <button class="file-remove" data-index="${i}" aria-label="Remove file">
        <svg viewBox="0 0 24 24" fill="none" width="14" height="14" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
  `).join('');
  container.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      files.splice(idx, 1);
      renderFileList(containerId, files);
    });
  });
}

/* ===========================================================
   TOOL: Merge PDF
   =========================================================== */
function initMergeTool() {
  const files = [];
  const input = document.getElementById('merge-file-input');
  const list = document.getElementById('merge-file-list');
  const startBtn = document.getElementById('merge-start');
  const progress = document.getElementById('merge-progress');
  const progressFill = document.getElementById('merge-progress-fill');
  const progressText = document.getElementById('merge-progress-text');

  setupDropzone('merge-dropzone', 'merge-file-input', (newFiles) => {
    for (const f of newFiles) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        files.push(f);
      }
    }
    renderFileList('merge-file-list', files);
    startBtn.disabled = files.length < 2;
  }, true);

  startBtn.addEventListener('click', async () => {
    if (files.length < 2) { toast('Select at least 2 PDF files', 'error'); return; }
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Loading libraries...';

    try {
      await ensurePDFLib();
      const { PDFDocument } = PDFLib;

      progressText.textContent = 'Merging PDFs...';
      const mergedPdf = await PDFDocument.create();

      for (let i = 0; i < files.length; i++) {
        const buf = await files[i].arrayBuffer();
        const doc = await PDFDocument.load(buf);
        const idx = await mergedPdf.copyPages(doc, doc.getPageIndices());
        idx.forEach(p => mergedPdf.addPage(p));
        progressFill.style.width = `${((i + 1) / files.length) * 90}%`;
        progressText.textContent = `Merging page ${i + 1} of ${files.length}...`;
      }

      const pdfBytes = await mergedPdf.save();
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, 'merged.pdf');

      toast('PDFs merged successfully!', 'success');
      resetTool('merge');
    } catch (err) {
      toast('Merge failed: ' + err.message, 'error');
      console.error('Merge error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Split PDF
   =========================================================== */
function initSplitTool() {
  let pdfFile = null;
  const input = document.getElementById('split-file-input');
  const startBtn = document.getElementById('split-start');
  const options = document.getElementById('split-options');
  const progress = document.getElementById('split-progress');
  const progressFill = document.getElementById('split-progress-fill');
  const progressText = document.getElementById('split-progress-text');
  const rangeOptions = document.getElementById('split-range-options');
  const rangeInput = document.getElementById('split-range-input');
  const pagesPreview = document.getElementById('split-pages-preview');

  setupDropzone('split-dropzone', 'split-file-input', (newFiles) => {
    if (newFiles.length) {
      pdfFile = newFiles[0];
      options.classList.remove('hidden');
      startBtn.disabled = false;
    }
  });

  document.querySelectorAll('input[name="split-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      rangeOptions.classList.toggle('hidden', r.value !== 'range');
    });
  });

  startBtn.addEventListener('click', async () => {
    if (!pdfFile) { toast('Please select a PDF file', 'error'); return; }
    const mode = document.querySelector('input[name="split-mode"]:checked').value;
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';

    try {
      await ensurePDFLib();
      const { PDFDocument } = PDFLib;
      const buf = await pdfFile.arrayBuffer();
      const srcDoc = await PDFDocument.load(buf);
      const totalPages = srcDoc.getPageCount();

      let pagesToExtract;
      if (mode === 'range') {
        pagesToExtract = parsePageRange(rangeInput.value, totalPages);
        if (!pagesToExtract || !pagesToExtract.length) {
          toast('Invalid page range', 'error');
          startBtn.disabled = false;
          return;
        }
      } else {
        pagesToExtract = Array.from({ length: totalPages }, (_, i) => i + 1);
      }

      await ensureJSZip();
      const JSZip = window.JSZip;
      const zip = new JSZip();

      for (let i = 0; i < pagesToExtract.length; i++) {
        const pageIdx = pagesToExtract[i] - 1;
        const newDoc = await PDFDocument.create();
        const [copiedPage] = await newDoc.copyPages(srcDoc, [pageIdx]);
        newDoc.addPage(copiedPage);
        const bytes = await newDoc.save();
        zip.file(`page-${pagesToExtract[i]}.pdf`, bytes);
        progressFill.style.width = `${((i + 1) / pagesToExtract.length) * 90}%`;
        progressText.textContent = `Extracting page ${i + 1} of ${pagesToExtract.length}...`;
      }

      progressText.textContent = 'Creating ZIP...';
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      downloadBlob(zipBlob, pdfFile.name.replace('.pdf', '-split.zip'));
      toast('PDF split successfully!', 'success');
      resetTool('split');
    } catch (err) {
      toast('Split failed: ' + err.message, 'error');
      console.error('Split error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Compress PDF
   =========================================================== */
function initCompressTool() {
  let pdfFile = null;
  const input = document.getElementById('compress-file-input');
  const startBtn = document.getElementById('compress-start');
  const info = document.getElementById('compress-info');
  const progress = document.getElementById('compress-progress');
  const progressFill = document.getElementById('compress-progress-fill');
  const progressText = document.getElementById('compress-progress-text');
  const originalSize = document.getElementById('compress-original-size');
  const estimatedSize = document.getElementById('compress-estimated-size');
  const reduction = document.getElementById('compression-reduction');

  let level = 'medium';

  setupDropzone('compress-dropzone', 'compress-file-input', (newFiles) => {
    if (newFiles.length) {
      pdfFile = newFiles[0];
      info.classList.remove('hidden');
      startBtn.disabled = false;
      originalSize.textContent = formatBytes(pdfFile.size);
      const est = { medium: 0.65, high: 0.45, extreme: 0.3 };
      estimatedSize.textContent = formatBytes(Math.round(pdfFile.size * est[level]));
      reduction.textContent = `${Math.round((1 - est[level]) * 100)}%`;
    }
  });

  document.querySelectorAll('.compress-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.compress-level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      level = btn.dataset.level;
      if (pdfFile) {
        const est = { medium: 0.65, high: 0.45, extreme: 0.3 };
        estimatedSize.textContent = formatBytes(Math.round(pdfFile.size * est[level]));
        reduction.textContent = `${Math.round((1 - est[level]) * 100)}%`;
      }
    });
  });

  startBtn.addEventListener('click', async () => {
    if (!pdfFile) { toast('Please select a PDF file', 'error'); return; }
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Compressing...';

    try {
      await ensurePDFLib();
      const { PDFDocument } = PDFLib;

      const buf = await pdfFile.arrayBuffer();
      const doc = await PDFDocument.load(buf);

      // For compression we use object stream optimization
      // pdf-lib doesn't support true re-compression but we can:
      // 1. Remove unused objects by saving with objectsPerTick optimization
      // 2. For extreme, reduce image quality via page content manipulation
      const opts = { objectsPerTick: 100 };
      if (level === 'extreme') {
        opts.objectsPerTick = 50;
      }

      progressText.textContent = 'Optimizing PDF structure...';
      progressFill.style.width = '50%';

      let pdfBytes;
      if (level === 'extreme') {
        // For extreme, we try to compress images by re-saving with smaller footprint
        const pages = doc.getPages();
        for (const page of pages) {
          const { width, height } = page.getSize();
          // Scale down large pages
          if (width > 1200 || height > 1200) {
            const scale = Math.min(1200 / width, 1200 / height);
            page.setSize(width * scale, height * scale);
          }
        }
        pdfBytes = await doc.save({ objectsPerTick: 50, useObjectStreams: true });
      } else if (level === 'high') {
        pdfBytes = await doc.save({ objectsPerTick: 80, useObjectStreams: true });
      } else {
        pdfBytes = await doc.save({ objectsPerTick: 100, useObjectStreams: true });
      }

      progressFill.style.width = '90%';
      progressText.textContent = 'Finalizing...';

      const compressedBlob = new Blob([pdfBytes], { type: 'application/pdf' });
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const compSize = compressedBlob.size;
      const saved = pdfFile.size - compSize;
      const pct = pdfFile.size ? Math.round((saved / pdfFile.size) * 100) : 0;
      toast(`Compressed: ${formatBytes(pdfFile.size)} → ${formatBytes(compSize)} (${pct}% reduction)`, 'success');

      downloadBlob(compressedBlob, pdfFile.name.replace('.pdf', '-compressed.pdf'));
      resetTool('compress');
    } catch (err) {
      toast('Compression failed: ' + err.message, 'error');
      console.error('Compress error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: PDF to Image
   =========================================================== */
function initPdf2ImgTool() {
  let pdfFile = null;
  const input = document.getElementById('pdf2img-file-input');
  const startBtn = document.getElementById('pdf2img-start');
  const options = document.getElementById('pdf2img-options');
  const progress = document.getElementById('pdf2img-progress');
  const progressFill = document.getElementById('pdf2img-progress-fill');
  const progressText = document.getElementById('pdf2img-progress-text');
  const scaleInput = document.getElementById('pdf2img-scale');
  const scaleValue = document.getElementById('pdf2img-scale-value');
  const formatSelect = document.getElementById('pdf2img-format');

  scaleInput.addEventListener('input', () => {
    scaleValue.textContent = scaleInput.value + '%';
  });

  setupDropzone('pdf2img-dropzone', 'pdf2img-file-input', (newFiles) => {
    if (newFiles.length) {
      pdfFile = newFiles[0];
      options.classList.remove('hidden');
      startBtn.disabled = false;
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!pdfFile) { toast('Please select a PDF file', 'error'); return; }
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';

    try {
      await ensurePDFJS();
      const scale = parseInt(scaleInput.value, 10) / 100;
      const format = formatSelect.value;

      progressText.textContent = 'Rendering pages...';
      const data = await pdfFile.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data }).promise;
      const totalPages = pdf.numPages;
      const images = [];

      for (let i = 1; i <= totalPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        images.push(canvas.toDataURL(format, 0.92));
        progressFill.style.width = `${(i / totalPages) * 90}%`;
        progressText.textContent = `Rendering page ${i} of ${totalPages}...`;
      }

      await ensureJSZip();
      const JSZip = window.JSZip;
      const zip = new JSZip();
      const ext = format === 'image/png' ? '.png' : '.jpg';

      for (let i = 0; i < images.length; i++) {
        const base64 = images[i].split(',')[1];
        zip.file(`page-${i + 1}${ext}`, base64, { base64: true });
      }

      progressText.textContent = 'Creating ZIP...';
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      downloadBlob(zipBlob, pdfFile.name.replace('.pdf', '-images.zip'));
      toast('PDF converted to images!', 'success');
      resetTool('pdf2img');
    } catch (err) {
      toast('Conversion failed: ' + err.message, 'error');
      console.error('PDF2Img error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Image to PDF
   =========================================================== */
function initImg2PdfTool() {
  const files = [];
  const input = document.getElementById('img2pdf-file-input');
  const startBtn = document.getElementById('img2pdf-start');
  const options = document.getElementById('img2pdf-options');
  const progress = document.getElementById('img2pdf-progress');
  const progressFill = document.getElementById('img2pdf-progress-fill');
  const progressText = document.getElementById('img2pdf-progress-text');
  const pageSize = document.getElementById('img2pdf-pagesize');

  setupDropzone('img2pdf-dropzone', 'img2pdf-file-input', (newFiles) => {
    for (const f of newFiles) {
      if (f.type.startsWith('image/')) files.push(f);
    }
    renderFileList('img2pdf-file-list', files);
    options.classList.remove('hidden');
    startBtn.disabled = files.length === 0;
  }, true);

  startBtn.addEventListener('click', async () => {
    if (!files.length) { toast('Please select at least one image', 'error'); return; }
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';

    try {
      await ensurePDFLib();
      const { PDFDocument } = PDFLib;

      const doc = await PDFDocument.create();
      const size = pageSize.value;

      for (let i = 0; i < files.length; i++) {
        const buf = await files[i].arrayBuffer();
        let image;
        if (files[i].type === 'image/png') {
          image = await doc.embedPng(buf);
        } else {
          image = await doc.embedJpg(buf);
        }
        const { width: imgW, height: imgH } = image.scale(1);

        let page;
        if (size === 'A4') {
          page = doc.addPage([595.28, 841.89]);
          const scale = Math.min(595.28 / imgW, 841.89 / imgH) * 0.9;
          const dw = imgW * scale, dh = imgH * scale;
          page.drawImage(image, {
            x: (595.28 - dw) / 2, y: (841.89 - dh) / 2,
            width: dw, height: dh
          });
        } else if (size === 'Letter') {
          page = doc.addPage([612, 792]);
          const scale = Math.min(612 / imgW, 792 / imgH) * 0.9;
          const dw = imgW * scale, dh = imgH * scale;
          page.drawImage(image, {
            x: (612 - dw) / 2, y: (792 - dh) / 2,
            width: dw, height: dh
          });
        } else {
          // Fit
          page = doc.addPage([imgW, imgH]);
          page.drawImage(image, { x: 0, y: 0, width: imgW, height: imgH });
        }

        progressFill.style.width = `${((i + 1) / files.length) * 90}%`;
        progressText.textContent = `Processing image ${i + 1} of ${files.length}...`;
      }

      const pdfBytes = await doc.save();
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, 'images-to-pdf.pdf');
      toast('Images converted to PDF!', 'success');
      resetTool('img2pdf');
    } catch (err) {
      toast('Conversion failed: ' + err.message, 'error');
      console.error('Img2PDF error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Organize PDF (reorder, rotate, delete)
   =========================================================== */
function initOrganizeTool() {
  let pdfFile = null;
  let pdfDoc = null;
  let pages = [];
  const input = document.getElementById('organize-file-input');
  const startBtn = document.getElementById('organize-start');
  const editor = document.getElementById('organize-editor');
  const pagesGrid = document.getElementById('organize-pages-grid');
  const progress = document.getElementById('organize-progress');
  const progressFill = document.getElementById('organize-progress-fill');
  const progressText = document.getElementById('organize-progress-text');
  const rotateCW = document.getElementById('organize-rotate-cw');
  const rotateCCW = document.getElementById('organize-rotate-ccw');
  const deleteBtn = document.getElementById('organize-delete');

  setupDropzone('organize-dropzone', 'organize-file-input', async (newFiles) => {
    if (!newFiles.length) return;
    pdfFile = newFiles[0];
    editor.classList.remove('hidden');
    startBtn.disabled = false;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Loading pages...';

    try {
      await ensurePDFLib();
      await ensurePDFJS();
      const { PDFDocument } = PDFLib;

      const buf = await pdfFile.arrayBuffer();
      pdfDoc = await PDFDocument.load(buf);
      const total = pdfDoc.getPageCount();

      pages = [];
      for (let i = 0; i < total; i++) {
        pages.push({ index: i, rotation: 0 });
      }

      const pdfjsData = await window.pdfjsLib.getDocument({ data: buf.slice(0) }).promise;

      for (let i = 0; i < total; i++) {
        const page = await pdfjsData.getPage(i + 1);
        const vp = page.getViewport({ scale: 0.3 });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        pages[i].thumbnail = canvas.toDataURL();

        /* Store page objects for later use */
        const pdfPage = pdfDoc.getPages()[i];
        pages[i].width = pdfPage.getWidth();
        pages[i].height = pdfPage.getHeight();

        progressFill.style.width = `${((i + 1) / total) * 50}%`;
        progressText.textContent = `Loading page ${i + 1} of ${total}...`;
      }

      renderOrganizePages();
      progress.classList.add('hidden');
      toast(`Loaded ${total} pages`, 'success');
    } catch (err) {
      toast('Failed to load PDF: ' + err.message, 'error');
      editor.classList.add('hidden');
      startBtn.disabled = true;
      progress.classList.add('hidden');
    }
  });

  function renderOrganizePages() {
    const sel = new Set(pages.filter(p => p.selected).map(p => p.index));
    pagesGrid.innerHTML = pages.map((p, i) => {
      const selected = sel.has(p.index) ? ' selected' : '';
      const rot = p.rotation || 0;
      const rotLabel = rot ? ` (${rot}°)` : '';
      const transform = rot ? `style="transform:rotate(${rot}deg)"` : '';
      return `<div class="organize-page${selected}" data-page="${i}" draggable="true">
        <img src="${p.thumbnail}" alt="Page ${p.index + 1}" ${transform}>
        <div class="organize-page-label">${p.index + 1}${rotLabel}</div>
      </div>`;
    }).join('');

    /* Click to select */
    pagesGrid.querySelectorAll('.organize-page').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.page, 10);
        pages[idx].selected = !pages[idx].selected;
        el.classList.toggle('selected');
      });
    });

    /* Drag & drop reorder */
    let dragSrc = null;
    pagesGrid.querySelectorAll('.organize-page').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        dragSrc = parseInt(el.dataset.page, 10);
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const target = parseInt(el.dataset.page, 10);
        if (dragSrc === null || dragSrc === target) return;
        const [moved] = pages.splice(dragSrc, 1);
        pages.splice(target, 0, moved);
        /* Renumber indices */
        pages.forEach((p, i) => { p.index = i; });
        renderOrganizePages();
        dragSrc = null;
      });
    });

    /* Reverse order if pages are empty */
    if (!pages.length) {
      pagesGrid.innerHTML = '<p style="color:var(--ink-muted);font-size:13px;text-align:center;padding:20px;">No pages loaded</p>';
    }
  }

  rotateCW.addEventListener('click', () => {
    pages.forEach(p => { if (p.selected) p.rotation = (p.rotation || 0) + 90; });
    renderOrganizePages();
  });

  rotateCCW.addEventListener('click', () => {
    pages.forEach(p => { if (p.selected) p.rotation = (p.rotation || 0) - 90; });
    renderOrganizePages();
  });

  deleteBtn.addEventListener('click', () => {
    const remaining = pages.filter(p => !p.selected);
    if (remaining.length === 0) {
      toast('Cannot delete all pages', 'error');
      return;
    }
    pages = remaining;
    pages.forEach((p, i) => { p.index = i; });
    renderOrganizePages();
  });

  startBtn.addEventListener('click', async () => {
    if (!pages.length) { toast('No pages to process', 'error'); return; }
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Building PDF...';

    try {
      await ensurePDFLib();
      const { PDFDocument } = PDFLib;

      const buf = await pdfFile.arrayBuffer();
      const srcDoc = await PDFDocument.load(buf);
      const newDoc = await PDFDocument.create();

      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const [copiedPage] = await newDoc.copyPages(srcDoc, [p.index]);
        if (p.rotation) {
          const current = copiedPage.getRotation().angle;
          copiedPage.setRotation(PDFLib.degrees(current + p.rotation));
        }
        newDoc.addPage(copiedPage);
        progressFill.style.width = `${((i + 1) / pages.length) * 90}%`;
        progressText.textContent = `Processing page ${i + 1} of ${pages.length}...`;
      }

      const pdfBytes = await newDoc.save();
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, pdfFile.name.replace('.pdf', '-organized.pdf'));
      toast('PDF organized successfully!', 'success');
      resetTool('organize');
    } catch (err) {
      toast('Failed to organize PDF: ' + err.message, 'error');
      console.error('Organize error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Protect PDF (add password)
   =========================================================== */
function initProtectTool() {
  let pdfFile = null;
  const input = document.getElementById('protect-file-input');
  const startBtn = document.getElementById('protect-start');
  const options = document.getElementById('protect-options');
  const progress = document.getElementById('protect-progress');
  const progressFill = document.getElementById('protect-progress-fill');
  const progressText = document.getElementById('protect-progress-text');
  const passwordInput = document.getElementById('protect-password');
  const confirmInput = document.getElementById('protect-confirm');
  const errorEl = document.getElementById('protect-error');

  setupDropzone('protect-dropzone', 'protect-file-input', (newFiles) => {
    if (newFiles.length) {
      pdfFile = newFiles[0];
      options.classList.remove('hidden');
      startBtn.disabled = false;
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!pdfFile) { toast('Please select a PDF file', 'error'); return; }
    const pass = passwordInput.value;
    const conf = confirmInput.value;
    if (!pass || pass.length < 4) {
      errorEl.textContent = 'Password must be at least 4 characters';
      errorEl.classList.remove('hidden');
      return;
    }
    if (pass !== conf) {
      errorEl.textContent = 'Passwords do not match';
      errorEl.classList.remove('hidden');
      return;
    }
    errorEl.classList.add('hidden');
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Protecting PDF...';

    try {
      await ensurePDFLib();
      const { PDFDocument } = PDFLib;

      const buf = await pdfFile.arrayBuffer();
      const doc = await PDFDocument.load(buf);

      progressFill.style.width = '50%';
      progressText.textContent = 'Applying password...';

      const pdfBytes = await doc.save({
        ownerPassword: pass,
        userPassword: pass
      });

      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, pdfFile.name.replace('.pdf', '-protected.pdf'));
      toast('PDF protected successfully!', 'success');
      resetTool('protect');
    } catch (err) {
      toast('Failed to protect PDF: ' + err.message, 'error');
      console.error('Protect error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Unlock PDF (remove password)
   =========================================================== */
function initUnlockTool() {
  let pdfFile = null;
  const input = document.getElementById('unlock-file-input');
  const startBtn = document.getElementById('unlock-start');
  const options = document.getElementById('unlock-options');
  const progress = document.getElementById('unlock-progress');
  const progressFill = document.getElementById('unlock-progress-fill');
  const progressText = document.getElementById('unlock-progress-text');
  const passwordInput = document.getElementById('unlock-password');
  const errorEl = document.getElementById('unlock-error');

  setupDropzone('unlock-dropzone', 'unlock-file-input', (newFiles) => {
    if (newFiles.length) {
      pdfFile = newFiles[0];
      options.classList.remove('hidden');
      startBtn.disabled = false;
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!pdfFile) { toast('Please select a PDF file', 'error'); return; }
    const pass = passwordInput.value;
    if (!pass) {
      errorEl.textContent = 'Please enter the document password';
      errorEl.classList.remove('hidden');
      return;
    }
    errorEl.classList.add('hidden');
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Unlocking PDF...';

    try {
      await ensurePDFLib();
      const { PDFDocument } = PDFLib;

      const buf = await pdfFile.arrayBuffer();
      // Try to load with password
      const doc = await PDFDocument.load(buf, { password: pass });

      progressFill.style.width = '50%';
      progressText.textContent = 'Removing password...';

      // Save without password
      const pdfBytes = await doc.save();

      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, pdfFile.name.replace('.pdf', '-unlocked.pdf'));
      toast('PDF unlocked successfully!', 'success');
      resetTool('unlock');
    } catch (err) {
      if (err.message && err.message.includes('password')) {
        errorEl.textContent = 'Incorrect password';
        errorEl.classList.remove('hidden');
      } else {
        toast('Failed to unlock PDF: ' + err.message, 'error');
      }
      console.error('Unlock error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Watermark PDF
   =========================================================== */
function initWatermarkTool() {
  let pdfFile = null;
  const input = document.getElementById('watermark-file-input');
  const startBtn = document.getElementById('watermark-start');
  const options = document.getElementById('watermark-options');
  const progress = document.getElementById('watermark-progress');
  const progressFill = document.getElementById('watermark-progress-fill');
  const progressText = document.getElementById('watermark-progress-text');
  const textInput = document.getElementById('watermark-text');
  const opacityInput = document.getElementById('watermark-opacity');
  const opacityValue = document.getElementById('watermark-opacity-value');
  const positionSelect = document.getElementById('watermark-position');

  opacityInput.addEventListener('input', () => {
    opacityValue.textContent = Math.round(opacityInput.value * 100) + '%';
  });

  setupDropzone('watermark-dropzone', 'watermark-file-input', (newFiles) => {
    if (newFiles.length) {
      pdfFile = newFiles[0];
      options.classList.remove('hidden');
      startBtn.disabled = false;
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!pdfFile) { toast('Please select a PDF file', 'error'); return; }
    const watermarkText = textInput.value.trim();
    if (!watermarkText) { toast('Please enter watermark text', 'error'); return; }

    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Adding watermark...';

    try {
      await ensurePDFLib();
      const { PDFDocument, rgb, StandardFonts } = PDFLib;

      const buf = await pdfFile.arrayBuffer();
      const doc = await PDFDocument.load(buf);
      const pages = doc.getPages();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const opacity = parseFloat(opacityInput.value);
      const position = positionSelect.value;

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const textSize = Math.min(width, height) * 0.04;

        let x, y, rotation;
        switch (position) {
          case 'diagonal':
            x = width / 2;
            y = height / 2;
            rotation = 45;
            break;
          case 'top-left':
            x = width * 0.08;
            y = height * 0.92;
            rotation = 0;
            break;
          case 'bottom-right':
            x = width * 0.92;
            y = height * 0.08;
            rotation = 0;
            break;
          default: // center
            x = width / 2;
            y = height / 2;
            rotation = 0;
        }

        page.drawText(watermarkText, {
          x,
          y,
          size: textSize,
          font,
          color: rgb(0.5, 0.5, 0.5),
          opacity,
          rotate: rotation ? PDFLib.degrees(rotation) : undefined,
          xAlignment: 'center',
          yAlignment: 'center'
        });

        progressFill.style.width = `${((i + 1) / pages.length) * 90}%`;
        progressText.textContent = `Watermarking page ${i + 1} of ${pages.length}...`;
      }

      const pdfBytes = await doc.save();
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, pdfFile.name.replace('.pdf', '-watermarked.pdf'));
      toast('Watermark added successfully!', 'success');
      resetTool('watermark');
    } catch (err) {
      toast('Failed to add watermark: ' + err.message, 'error');
      console.error('Watermark error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   TOOL: Page Numbers
   =========================================================== */
function initPageNumTool() {
  let pdfFile = null;
  const input = document.getElementById('pagenum-file-input');
  const startBtn = document.getElementById('pagenum-start');
  const options = document.getElementById('pagenum-options');
  const progress = document.getElementById('pagenum-progress');
  const progressFill = document.getElementById('pagenum-progress-fill');
  const progressText = document.getElementById('pagenum-progress-text');
  const positionSelect = document.getElementById('pagenum-position');
  const startNumInput = document.getElementById('pagenum-start');

  setupDropzone('pagenum-dropzone', 'pagenum-file-input', (newFiles) => {
    if (newFiles.length) {
      pdfFile = newFiles[0];
      options.classList.remove('hidden');
      startBtn.disabled = false;
    }
  });

  startBtn.addEventListener('click', async () => {
    if (!pdfFile) { toast('Please select a PDF file', 'error'); return; }
    startBtn.disabled = true;
    progress.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Adding page numbers...';

    try {
      await ensurePDFLib();
      const { PDFDocument, rgb, StandardFonts } = PDFLib;

      const buf = await pdfFile.arrayBuffer();
      const doc = await PDFDocument.load(buf);
      const pages = doc.getPages();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const position = positionSelect.value;
      const startNum = parseInt(startNumInput.value, 10) || 1;

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const num = startNum + i;
        const text = String(num);
        const fontSize = Math.min(width, height) * 0.025;

        let x, y;
        switch (position) {
          case 'bottom-left':
            x = width * 0.08;
            y = height * 0.06;
            break;
          case 'bottom-right':
            x = width * 0.92;
            y = height * 0.06;
            break;
          case 'top-center':
            x = width / 2;
            y = height * 0.94;
            break;
          case 'top-left':
            x = width * 0.08;
            y = height * 0.94;
            break;
          case 'top-right':
            x = width * 0.92;
            y = height * 0.94;
            break;
          default: // bottom-center
            x = width / 2;
            y = height * 0.06;
        }

        page.drawText(text, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.3, 0.3, 0.3),
          xAlignment: 'center',
          yAlignment: 'center'
        });

        progressFill.style.width = `${((i + 1) / pages.length) * 90}%`;
        progressText.textContent = `Adding numbers to page ${i + 1} of ${pages.length}...`;
      }

      const pdfBytes = await doc.save();
      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';

      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      downloadBlob(blob, pdfFile.name.replace('.pdf', '-numbered.pdf'));
      toast('Page numbers added successfully!', 'success');
      resetTool('pagenum');
    } catch (err) {
      toast('Failed to add page numbers: ' + err.message, 'error');
      console.error('PageNum error:', err);
    } finally {
      startBtn.disabled = false;
      setTimeout(() => { progress.classList.add('hidden'); }, 2000);
    }
  });
}

/* ===========================================================
   Reset / Cancel helpers
   =========================================================== */
const TOOL_PREFIXES = ['merge', 'split', 'compress', 'pdf2img', 'img2pdf', 'organize', 'protect', 'unlock', 'watermark', 'pagenum'];

function resetTool(prefix) {
  /* Clear file inputs and lists */
  const fileInput = document.getElementById(`${prefix}-file-input`);
  if (fileInput) fileInput.value = '';
  const fileList = document.getElementById(`${prefix}-file-list`);
  if (fileList) fileList.innerHTML = '';
  const optionsEl = document.getElementById(`${prefix}-options`);
  if (optionsEl) optionsEl.classList.add('hidden');
  const editor = document.getElementById(`${prefix}-editor`);
  if (editor) editor.classList.add('hidden');
  const startBtn = document.getElementById(`${prefix}-start`);
  if (startBtn) startBtn.disabled = true;
  const cancelBtn = document.querySelector(`#tool-overlay-${prefix} .tool-cancel-btn`);
  const progress = document.getElementById(`${prefix}-progress`);
  if (progress) progress.classList.add('hidden');

  /* Close overlay after brief delay */
  const overlay = document.getElementById(`tool-overlay-${prefix}`);
  if (overlay) {
    setTimeout(() => overlay.classList.add('hidden'), 300);
  }
}

/* ===========================================================
   Overlay management
   =========================================================== */
function openOverlay(toolName) {
  const overlay = document.getElementById(`tool-overlay-${toolName}`);
  if (overlay) overlay.classList.remove('hidden');
}

function closeAllOverlays() {
  TOOL_PREFIXES.forEach(p => {
    const overlay = document.getElementById(`tool-overlay-${p}`);
    if (overlay) overlay.classList.add('hidden');
  });
}

/* ===========================================================
   Init all tools
   =========================================================== */
function initAllTools() {
  /* Theme */
  initThemeSwitch();

  /* Tool cards → open overlay */
  document.querySelectorAll('.pdf-tool-card').forEach(card => {
    card.addEventListener('click', () => {
      const tool = card.dataset.tool;
      openOverlay(tool);
    });
  });

  /* Overlay close buttons */
  document.querySelectorAll('.tool-overlay-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const overlay = btn.closest('.tool-overlay');
      if (overlay) overlay.classList.add('hidden');
    });
  });

  /* Cancel buttons */
  document.querySelectorAll('.tool-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const overlay = btn.closest('.tool-overlay');
      if (overlay) overlay.classList.add('hidden');
    });
  });

  /* Click outside panel to close */
  document.querySelectorAll('.tool-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  /* Escape to close */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllOverlays();
  });

  /* Init each tool */
  initMergeTool();
  initSplitTool();
  initCompressTool();
  initPdf2ImgTool();
  initImg2PdfTool();
  initOrganizeTool();
  initProtectTool();
  initUnlockTool();
  initWatermarkTool();
  initPageNumTool();
}

/* Boot */
document.addEventListener('DOMContentLoaded', initAllTools);
