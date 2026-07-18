/* ===========================================================
   IST Trust Zone — PDF Tools Engine v2
   Client-side PDF processing with Undo/Redo, thumbnails,
   drag-drop reorder, and advanced editing features.
   All files are processed locally — nothing leaves your device.
   =========================================================== */

/* Local toast — no Firebase dependency needed for PDF Tools */
let _toastTimer = null;
function toast(msg, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  container.appendChild(el);
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.style.transition = 'opacity 200ms ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

/* ---- Constants ---- */
const PDFLIB_URL = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const PDFJS_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const JSZIP_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

/* ---- Lazy library loader ---- */
const _cache = {};
function loadScript(url) {
  if (_cache[url]) return _cache[url];
  _cache[url] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(window);
    s.onerror = () => reject(Error('Failed to load ' + url));
    document.head.appendChild(s);
  });
  return _cache[url];
}
let _pdfjsReady = false;
async function pdfjs() { if (!_pdfjsReady) { await loadScript(PDFJS_URL); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; _pdfjsReady = true; } }
async function pdflib() { await loadScript(PDFLIB_URL); }
async function jszip() { await loadScript(JSZIP_URL); }

/* ---- Helpers ---- */
function fmtBytes(b) {
  if (!b && b !== 0) return '0 B';
  if (b < 1024) return b + ' B';
  const u = ['KB','MB','GB']; let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' ' + u[i];
}

function dlBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function parseRange(input, total) {
  if (!input || !input.trim()) return null;
  const s = new Set();
  for (const part of input.split(',').map(s => s.trim())) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const st = parseInt(m[1],10), en = m[2] ? parseInt(m[2],10) : st;
    if (st < 1 || en > total || st > en) return null;
    for (let i = st; i <= en; i++) s.add(i);
  }
  return s.size ? [...s].sort((a,b)=>a-b) : null;
}

function defaultFilename(original, suffix = '') {
  const base = original.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_\-]/g, '_');
  return `IstServices_${base}${suffix}`;
}

/* ===========================================================
   UndoRedoManager
   =========================================================== */
class UndoRedoManager {
  constructor(maxSteps = 50) {
    this.stack = [];
    this.idx = -1;
    this.max = maxSteps;
    this.undoBtn = null;
    this.redoBtn = null;
    this.onChange = null;
  }
  bind(undoId, redoId) {
    this.undoBtn = document.getElementById(undoId);
    this.redoBtn = document.getElementById(redoId);
    if (this.undoBtn) this.undoBtn.addEventListener('click', () => this.undo());
    if (this.redoBtn) this.redoBtn.addEventListener('click', () => this.redo());
    this._sync();
  }
  push(state) {
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(JSON.parse(JSON.stringify(state)));
    if (this.stack.length > this.max) this.stack.shift();
    this.idx = this.stack.length - 1;
    this._sync();
  }
  undo() {
    if (this.idx <= 0) return;
    this.idx--;
    this._restore();
  }
  redo() {
    if (this.idx >= this.stack.length - 1) return;
    this.idx++;
    this._restore();
  }
  _restore() {
    if (this.onChange) this.onChange(JSON.parse(JSON.stringify(this.stack[this.idx])));
    this._sync();
  }
  canUndo() { return this.idx > 0; }
  canRedo() { return this.idx < this.stack.length - 1; }
  current() { return this.idx >= 0 ? JSON.parse(JSON.stringify(this.stack[this.idx])) : null; }
  _sync() {
    if (this.undoBtn) this.undoBtn.disabled = !this.canUndo();
    if (this.redoBtn) this.redoBtn.disabled = !this.canRedo();
  }
  reset() {
    this.stack = [];
    this.idx = -1;
    this._sync();
  }
}

/* ===========================================================
   Thumbnail / Page Helpers
   =========================================================== */
const _thumbCache = {};
const THUMB_BATCH_SIZE = 4; // Pages to render before yielding to main thread

/* Yield to main thread via requestAnimationFrame */
function yieldToMain() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/* Render a single page thumbnail (used by batch processor) */
/* Counter for unique thumbnail keys (ArrayBuffer.toString() is '[object ArrayBuffer]' for all) */
let _thumbId = 0;

async function renderSingleThumbnail(pdfData, pageNum, scale = 0.5, fileId = '') {
  const key = fileId ? fileId + '_' + pageNum + '_' + scale : 'pdf_' + (++_thumbId) + '_' + pageNum + '_' + scale;
  if (_thumbCache[key]) return _thumbCache[key];
  await pdfjs();
  const pdf = await window.pdfjsLib.getDocument({ data: pdfData.slice(0) }).promise;
  const pg = await pdf.getPage(pageNum);
  const vp = pg.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = vp.width;
  c.height = vp.height;
  await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const dataUrl = c.toDataURL('image/jpeg', 0.92);
  _thumbCache[key] = dataUrl;
  return dataUrl;
}

/* Batched async thumbnail renderer — renders in small batches,
   yields to main thread between each batch so UI never freezes.
   Calls onProgress callback after each page completes. */
async function renderThumbnailsBatched(pdfData, totalPages, scale = 0.5, onProgress = null, fileId = '') {
  const results = new Array(totalPages).fill(null);
  let renderedCount = 0;
  
  // Render first 2 pages immediately for instant feedback
  const urgentCount = Math.min(2, totalPages);
  for (let i = 0; i < urgentCount; i++) {
    try {
      results[i] = await renderSingleThumbnail(pdfData, i + 1, scale, fileId);
      renderedCount++;
      if (onProgress) onProgress(i, totalPages, results[i]);
    } catch (err) {
      console.warn('Thumbnail render failed for page', i + 1, err);
    }
  }
  
  // Render remaining pages in batches, yielding between each batch
  for (let i = urgentCount; i < totalPages; i += THUMB_BATCH_SIZE) {
    await yieldToMain(); // Let UI breathe
    
    const batchEnd = Math.min(i + THUMB_BATCH_SIZE, totalPages);
    const batchPromises = [];
    
    for (let j = i; j < batchEnd; j++) {
      batchPromises.push(
        renderSingleThumbnail(pdfData, j + 1, scale, fileId)
          .then(dataUrl => { results[j] = dataUrl; renderedCount++; if (onProgress) onProgress(j, totalPages, dataUrl); return dataUrl; })
          .catch(err => { console.warn('Thumbnail render failed for page', j + 1, err); renderedCount++; return null; })
      );
    }
    
    await Promise.all(batchPromises);
  }
  
  return results;
}

/* Legacy helper — renders a single thumbnail with cache */
async function renderThumbnail(pdfData, pageNum, scale = 0.5) {
  return renderSingleThumbnail(pdfData, pageNum, scale);
}

function clearThumbCache() { 
  for (const k in _thumbCache) delete _thumbCache[k];
}

/* Debounce — limits how often a function can fire */
function debounce(fn, ms = 100) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* Create a page item descriptor for a single page */
function makePageItem(pdfIndex, pageNum, rotation = 0, label = null) {
  return { pdfIndex, pageNum, rotation, label: label || String(pageNum), thumbnail: null, selected: false };
}

/* Render a page thumbnail grid */
function renderPageGrid(container, pages, options = {}) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  if (!el) return;
  const {
    onSelect, onRotateCW, onRotateCCW, onDelete,
    onDragStart, onDragOver, onDrop, onDragEnd,
    showCheck = true, showActions = true, compact = false
  } = options;

  const cls = compact ? 'page-thumb-item compact' : 'page-thumb-item';
  el.innerHTML = pages.map((p, i) => `
    <div class="${cls}${p.selected ? ' selected' : ''}" data-idx="${i}" draggable="true">
      ${showCheck ? `<div class="page-thumb-check">${p.selected ? '✓' : ''}</div>` : ''}
      ${showActions ? `
      <button class="page-thumb-btn page-thumb-del" data-idx="${i}" title="Delete this page">✕</button>
      <button class="page-thumb-btn page-thumb-rot-cw" data-idx="${i}" title="Rotate CW">↻</button>
      <button class="page-thumb-btn page-thumb-rot-ccw" data-idx="${i}" title="Rotate CCW">↺</button>` : ''}
      <div class="page-thumb-img-wrap">
        ${p.thumbnail ? `<img src="${p.thumbnail}" alt="Page ${p.pageNum}" loading="lazy"${p.rotation ? ' style="transform:rotate('+p.rotation+'deg)"' : ''}>` : '<div class="page-thumb-placeholder"><span class="thumb-spinner"></span></div>'}
      </div>
      <div class="page-thumb-label">${p.label || p.pageNum}</div>
    </div>
  `).join('');

  /* Attach events */
  el.querySelectorAll('.page-thumb-item').forEach(item => {
    const idx = parseInt(item.dataset.idx, 10);
    item.addEventListener('click', (e) => {
      if (e.target.closest('.page-thumb-actions')) return;
      if (onSelect) onSelect(idx);
    });
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
      item.classList.add('dragging');
      if (onDragStart) onDragStart(idx, e);
    });
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); if (onDragOver) onDragOver(idx, e); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!isNaN(from) && from !== idx && onDrop) onDrop(from, idx);
    });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); if (onDragEnd) onDragEnd(); });
  });

  /* Rotate/Delete buttons */
  el.querySelectorAll('.page-thumb-rot-cw').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); if (onRotateCW) onRotateCW(parseInt(b.dataset.idx, 10)); }));
  el.querySelectorAll('.page-thumb-rot-ccw').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); if (onRotateCCW) onRotateCCW(parseInt(b.dataset.idx, 10)); }));
  el.querySelectorAll('.page-thumb-del').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); if (onDelete) onDelete(parseInt(b.dataset.idx, 10)); }));
}

/* ===========================================================
   SPLIT PDF
   =========================================================== */
function initSplitTool() {
  let pdfFiles = [];        // array of { file, data, pages: [pageItems] }
  let undo;                 // UndoRedoManager
  const gridId = 'split-pages-grid';

  function getState() {
    return pdfFiles.map(f => ({
      name: f.file.name,
      pages: f.pages.map(p => ({ pageNum: p.pageNum, rotation: p.rotation, selected: p.selected, label: p.label }))
    }));
  }
  function applyState(state) {
    pdfFiles = state.map(s => {
      const existing = pdfFiles.find(e => e.file.name === s.name);
      return {
        file: existing ? existing.file : null,
        data: existing ? existing.data : null,
        pages: s.pages.map((p, i) => ({ ...p, thumbnail: existing && existing.pages[i] ? existing.pages[i].thumbnail : null }))
      };
    });
    renderSplitGrid();
    updateSplitUI();
  }

  function selectPage(idx) {
    const all = allPages();
    if (all[idx]) { all[idx].selected = !all[idx].selected; renderSplitGrid(); }
  }
  function rotateCW(idx) {
    const all = allPages();
    if (all[idx]) { all[idx].rotation = (all[idx].rotation || 0) + 90; undo.push(getState()); renderSplitGrid(); }
  }
  function rotateCCW(idx) {
    const all = allPages();
    if (all[idx]) { all[idx].rotation = (all[idx].rotation || 0) - 90; undo.push(getState()); renderSplitGrid(); }
  }
  function deletePage(idx) {
    const all = allPages();
    if (all[idx]) {
      // Find which pdfFile this belongs to
      let count = 0;
      for (const f of pdfFiles) {
        if (idx < count + f.pages.length) {
          f.pages.splice(idx - count, 1);
          undo.push(getState()); renderSplitGrid(); updateSplitUI(); return;
        }
        count += f.pages.length;
      }
    }
  }

  function allPages() { return pdfFiles.reduce((a, f) => a.concat(f.pages), []); }
  function allSelected() { return allPages().filter(p => p.selected); }

  function renderSplitGrid() {
    const all = allPages();
    renderPageGrid(gridId, all, {
      onSelect: selectPage, onRotateCW: rotateCW, onRotateCCW: rotateCCW, onDelete: deletePage,
      onDrop(from, to) {
        const all = allPages();
        if (from < 0 || from >= all.length || to < 0 || to >= all.length) return;
        // Move page from one position to another, potentially across PDFs
        const srcPage = all[from];
        let srcPdf = null, srcIdx = -1, count = 0;
        for (const f of pdfFiles) {
          if (from < count + f.pages.length) { srcPdf = f; srcIdx = from - count; break; }
          count += f.pages.length;
        }
        if (!srcPdf) return;
        const [moved] = srcPdf.pages.splice(srcIdx, 1);
        // Insert at target position
        count = 0;
        for (const f of pdfFiles) {
          if (to <= count + f.pages.length) {
            f.pages.splice(to - count, 0, moved);
            break;
          }
          count += f.pages.length;
        }
        undo.push(getState()); renderSplitGrid(); updateSplitUI();
      }
    });
  }

  function updateSplitUI() {
    const all = allPages();
    const cnt = document.getElementById('split-page-count');
    if (cnt) cnt.textContent = all.length + ' pages';
    const sel = allSelected().length;
    const startBtn = document.getElementById('split-start');
    if (startBtn) startBtn.disabled = all.length === 0;
    const toolbar = document.getElementById('split-toolbar');
    if (toolbar) toolbar.classList.toggle('hidden', all.length === 0);
    const exportOpts = document.getElementById('split-export-opts');
    if (exportOpts) exportOpts.classList.toggle('hidden', all.length === 0);
    const undoBar = document.getElementById('split-undo-bar');
    if (undoBar) undoBar.classList.toggle('hidden', all.length === 0);
  }

  /* Dropzone setup */
  const dz = document.getElementById('split-dropzone');
  const inp = document.getElementById('split-file-input');
  dz.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => handleSplitFiles(Array.from(inp.files)));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleSplitFiles(Array.from(e.dataTransfer.files)); });

  async function handleSplitFiles(files) {
    const pdfFiles2 = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfFiles2.length) { toast('Please select PDF files', 'error'); return; }

    for (const file of pdfFiles2) {
      const data = await file.arrayBuffer();
      await pdflib();
      const doc = await PDFLib.PDFDocument.load(data);
      const total = doc.getPageCount();
      const pdfEntry = { file, data, pages: [] };
      for (let i = 0; i < total; i++) {
        pdfEntry.pages.push(makePageItem(pdfFiles.length, i + 1, 0, `Page ${i+1}`));
      }
      // Generate thumbnails — first 3 pages sync for instant display, rest async
      toast(`Loading ${total} pages from ${file.name}...`);
      const fileId = file.name + '_' + Date.now();
      const urgentCount = Math.min(3, total);
      for (let u = 0; u < urgentCount; u++) {
        try {
          const url = await renderSingleThumbnail(data, u + 1, 0.5, fileId);
          if (url) pdfEntry.pages[u].thumbnail = url;
        } catch (e) { console.warn('Urgent thumb failed:', u+1, e); }
      }
      // Render remaining pages in background
      renderThumbnailsBatched(data, total, 0.5, (pageIdx, totalPgs, dataUrl) => {
        // Find current page entry in the ACTIVE pdfFiles array (handles undo/redo)
        for (const pf of pdfFiles) {
          if (pf.file === file && pf.pages[pageIdx]) {
            pf.pages[pageIdx].thumbnail = dataUrl;
            break;
          }
        }
        // Update DOM directly
        try {
          const grid = document.getElementById('split-pages-grid');
          if (!grid) return;
          const items = grid.querySelectorAll('.page-thumb-item');
          if (items[pageIdx]) {
            const wrap = items[pageIdx].querySelector('.page-thumb-img-wrap');
            if (wrap) {
              const existing = wrap.querySelector('img');
              if (existing) { existing.src = dataUrl; }
              else {
                const img = document.createElement('img');
                img.src = dataUrl;
                img.alt = 'Page ' + (pageIdx + 1);
                img.loading = 'lazy';
                wrap.innerHTML = '';
                wrap.appendChild(img);
              }
            }
          }
        } catch (e) { /* DOM may have changed */ }
      }, fileId);
      pdfFiles.push(pdfEntry);
    }
    undo.reset();
    undo.push(getState());
    renderSplitGrid();
    updateSplitUI();
    toast(`Loaded ${pdfFiles2.length} PDF(s)`, 'success');
  }

  /* Init undo */
  undo = new UndoRedoManager();
  undo.bind('split-undo', 'split-redo');
  undo.onChange = (state) => applyState(state);

  /* Select All / Deselect All */
  document.querySelector('#split-toolbar .page-select-all')?.addEventListener('click', () => {
    const all = allPages();
    all.forEach(p => { p.selected = true; });
    renderSplitGrid();
  });
  document.querySelector('#split-toolbar .page-deselect-all')?.addEventListener('click', () => {
    const all = allPages();
    all.forEach(p => { p.selected = false; });
    renderSplitGrid();
  });
  /* Rotate All (for selected, or all if none selected) */
  document.querySelector('#split-toolbar .page-rotate-cw-all')?.addEventListener('click', () => {
    const all = allPages();
    const sel = all.filter(p => p.selected);
    (sel.length ? sel : all).forEach(p => { p.rotation = (p.rotation || 0) + 90; });
    undo.push(getState()); renderSplitGrid();
  });
  document.querySelector('#split-toolbar .page-rotate-ccw-all')?.addEventListener('click', () => {
    const all = allPages();
    const sel = all.filter(p => p.selected);
    (sel.length ? sel : all).forEach(p => { p.rotation = (p.rotation || 0) - 90; });
    undo.push(getState()); renderSplitGrid();
  });
  /* Delete Selected */
  document.querySelector('#split-toolbar .page-delete-selected')?.addEventListener('click', () => {
    const all = allPages();
    // Remove selected pages from their PDFs
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].selected) {
        let count = 0;
        for (const f of pdfFiles) {
          if (i < count + f.pages.length) { f.pages.splice(i - count, 1); break; }
          count += f.pages.length;
        }
      }
    }
    pdfFiles = pdfFiles.filter(f => f.pages.length > 0);
    undo.push(getState()); renderSplitGrid(); updateSplitUI();
  });

  /* Export */
  document.getElementById('split-start').addEventListener('click', async () => {
    const all = allPages();
    if (!all.length) return;
    const mode = document.querySelector('input[name="split-export-mode"]:checked').value;
    const outName = document.getElementById('split-output-name').value.trim();
    const startBtn = document.getElementById('split-start');
    startBtn.disabled = true;

    const pagesToExport = all;

    try {
      await pdflib();
      const { PDFDocument } = PDFLib;

      if (mode === 'single') {
        const newDoc = await PDFDocument.create();
        for (const p of pagesToExport) {
          // Find which pdfFile has the original data
          let srcData = null;
          for (const f of pdfFiles) {
            if (f.pages.includes(p)) { srcData = f.data; break; }
          }
          if (!srcData) continue;
          const src = await PDFDocument.load(srcData);
          const [cp] = await newDoc.copyPages(src, [p.pageNum - 1]);
          if (p.rotation) cp.setRotation(PDFLib.degrees(cp.getRotation().angle + p.rotation));
          newDoc.addPage(cp);
        }
        const bytes = await newDoc.save();
        const name = outName || defaultFilename(pdfFiles[0].file.name, '.pdf');
        dlBlob(new Blob([bytes], {type:'application/pdf'}), name);
        toast('PDF exported successfully!', 'success');
      } else {
        // ZIP
        await jszip();
        const JSZip = window.JSZip;
        const zip = new JSZip();
        for (let i = 0; i < pagesToExport.length; i++) {
          const p = pagesToExport[i];
          let srcData = null;
          for (const f of pdfFiles) {
            if (f.pages.includes(p)) { srcData = f.data; break; }
          }
          if (!srcData) continue;
          const src = await PDFDocument.load(srcData);
          const nd = await PDFDocument.create();
          const [cp] = await nd.copyPages(src, [p.pageNum - 1]);
          if (p.rotation) cp.setRotation(PDFLib.degrees(cp.getRotation().angle + p.rotation));
          nd.addPage(cp);
          zip.file(`page-${p.pageNum}.pdf`, await nd.save());
        }
        const name = outName || defaultFilename(pdfFiles[0].file.name, '-split.zip');
        const blob = await zip.generateAsync({type:'blob'});
        dlBlob(blob, name);
        toast('PDF pages exported as ZIP!', 'success');
      }
      resetTool('split');
    } catch (err) {
      toast('Export failed: ' + err.message, 'error');
      console.error(err);
    } finally {
      startBtn.disabled = false;
    }
  });
}

/* ===========================================================
   MERGE PDF
   =========================================================== */
function initMergeTool() {
  let pdfFiles = []; // { file, data, pages: [pageItems], expanded: bool }
  let undo;

  function getState() {
    return pdfFiles.map((f, fi) => ({
      name: f.file.name,
      index: fi,
      pages: f.pages.map(p => ({ pageNum: p.pageNum, rotation: p.rotation, selected: p.selected, label: p.label })),
      expanded: f.expanded
    }));
  }
  function applyState(state) {
    // Store references to current files for data recovery
    const fileMap = {};
    pdfFiles.forEach((f, fi) => { fileMap[f.file.name] = { file: f.file, data: f.data, pages: f.pages }; });
    
    pdfFiles = state.map(s => {
      const ex = fileMap[s.name];
      return {
        file: ex ? ex.file : null,
        data: ex ? ex.data : null,
        expanded: s.expanded,
        pages: s.pages.map((p, i) => {
          const thumb = ex && ex.pages[i] ? ex.pages[i].thumbnail : null;
          return { ...p, thumbnail: thumb };
        })
      };
    });
    renderMergeCards();
    updateMergeUI();
  }

  function toggleCard(idx) {
    const f = pdfFiles[idx];
    if (f) { f.expanded = !f.expanded; renderMergeCards(); }
  }

  function removePdf(idx) {
    pdfFiles.splice(idx, 1);
    undo.push(getState());
    renderMergeCards();
    updateMergeUI();
  }

  function allPages() { return pdfFiles.reduce((a, f) => a.concat(f.pages.map(p => ({...p, _pdfIdx: pdfFiles.indexOf(f)}))), []); }

  function renderMergeCards() {
    const el = document.getElementById('merge-pdf-cards');
    if (!el) return;
    el.innerHTML = pdfFiles.map((f, fi) => `
      <div class="merge-pdf-card" data-pdf="${fi}">
        <div class="merge-pdf-card-header${f.expanded ? ' expanded' : ''}">
          <svg class="card-expand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          <span class="card-filename" title="${f.file.name}">${f.file.name}</span>
          <span class="card-pagecount">${f.pages.length} pages</span>
          <button class="card-remove" data-pdf="${fi}" title="Remove PDF">✕</button>
        </div>
        <div class="merge-pdf-card-body${f.expanded ? ' open' : ''}" data-body="${fi}">
          <div class="page-thumb-grid" data-pdf-grid="${fi}"></div>
        </div>
      </div>
    `).join('');

    /* Events */
    el.querySelectorAll('.merge-pdf-card-header').forEach(h => {
      h.addEventListener('click', (e) => {
        if (e.target.closest('.card-remove')) return;
        const fi = parseInt(h.closest('.merge-pdf-card').dataset.pdf, 10);
        toggleCard(fi);
      });
    });
    el.querySelectorAll('.card-remove').forEach(b => {
      b.addEventListener('click', (e) => { e.stopPropagation(); removePdf(parseInt(b.dataset.pdf, 10)); });
    });
    /* After each card re-render, enable undo bar if there's history */
    const undoBar = document.getElementById('merge-undo-bar');
    if (undoBar) undoBar.classList.toggle('hidden', pdfFiles.length === 0);
    if (undo && pdfFiles.length > 0) { undo._sync(); }

    /* Render page grids inside expanded cards */
    pdfFiles.forEach((f, fi) => {
      if (!f.expanded) return;
      const grid = el.querySelector(`[data-pdf-grid="${fi}"]`);
      if (!grid) return;
      renderPageGrid(grid, f.pages, {
        compact: true, showCheck: true, showActions: true,
        onSelect(idx) { f.pages[idx].selected = !f.pages[idx].selected; renderMergeCards(); },
        onRotateCW(idx) { f.pages[idx].rotation = (f.pages[idx].rotation || 0) + 90; undo.push(getState()); renderMergeCards(); },
        onRotateCCW(idx) { f.pages[idx].rotation = (f.pages[idx].rotation || 0) - 90; undo.push(getState()); renderMergeCards(); },
        onDelete(idx) { f.pages.splice(idx, 1); if (!f.pages.length) pdfFiles.splice(fi, 1); undo.push(getState()); renderMergeCards(); updateMergeUI(); },
        onDrop(fromIdx, toIdx) {
          // Calculate global page positions
          let globalPages = [];
          pdfFiles.forEach(pf => pf.pages.forEach(p => globalPages.push({ pdf: pf, page: p })));
          if (fromIdx < 0 || fromIdx >= globalPages.length || toIdx < 0 || toIdx >= globalPages.length) return;
          const [moved] = globalPages.splice(fromIdx, 1);
          const target = globalPages[toIdx];
          if (!target) return;
          // Remove from original PDF
          const srcPdf = moved.pdf;
          const srcPageIdx = srcPdf.pages.indexOf(moved.page);
          if (srcPageIdx >= 0) srcPdf.pages.splice(srcPageIdx, 1);
          // Insert at target PDF
          const tgtPdf = target.pdf;
          const tgtPageIdx = tgtPdf.pages.indexOf(target.page);
          tgtPdf.pages.splice(tgtPageIdx >= 0 ? tgtPageIdx : tgtPdf.pages.length, 0, moved.page);
          // Clean up empty PDFs
          pdfFiles = pdfFiles.filter(pf => pf.pages.length > 0);
          undo.push(getState()); renderMergeCards(); updateMergeUI();
        }
      }, true);
    });
  }

  function updateMergeUI() {
    const total = pdfFiles.reduce((a, f) => a + f.pages.length, 0);
    const startBtn = document.getElementById('merge-start');
    startBtn.disabled = pdfFiles.length < 2 && total < 2;
    const undoBar = document.getElementById('merge-undo-bar');
    if (undoBar) undoBar.classList.toggle('hidden', pdfFiles.length === 0);
  }

  /* Dropzone */
  const dz = document.getElementById('merge-dropzone');
  const inp = document.getElementById('merge-file-input');
  dz.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => handleMergeFiles(Array.from(inp.files)));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleMergeFiles(Array.from(e.dataTransfer.files)); });

  async function handleMergeFiles(files) {
    const pfs = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!pfs.length) { toast('Please select PDF files', 'error'); return; }
    for (const file of pfs) {
      const data = await file.arrayBuffer();
      await pdflib();
      const doc = await PDFLib.PDFDocument.load(data);
      const total = doc.getPageCount();
      const entry = { file, data, pages: [], expanded: false };
      for (let i = 0; i < total; i++) {
        entry.pages.push(makePageItem(null, i + 1, 0, `Page ${i+1}`));
      }
      // Generate thumbnails — first 3 pages sync for instant display, rest async
      toast(`Loading ${file.name}...`);
      const mergeFileId = file.name + '_' + Date.now() + '_merge';
      const urgentMerge = Math.min(3, total);
      for (let u = 0; u < urgentMerge; u++) {
        try {
          const url = await renderSingleThumbnail(data, u + 1, 0.4, mergeFileId);
          if (url) entry.pages[u].thumbnail = url;
        } catch (e) { console.warn('Merge urgent thumb failed:', u+1, e); }
      }
      renderThumbnailsBatched(data, total, 0.4, (pageIdx, totalPgs, dataUrl) => {
        // Find current page entry in ACTIVE pdfFiles
        for (const pf of pdfFiles) {
          if (pf.file === file && pf.pages[pageIdx]) {
            pf.pages[pageIdx].thumbnail = dataUrl;
            // Update DOM directly if card is expanded
            if (pf.expanded) {
              try {
                const cards = document.getElementById('merge-pdf-cards');
                if (!cards) break;
                const cardIdx = pdfFiles.indexOf(pf);
                if (cardIdx < 0) break;
                const grid = cards.querySelector(`[data-pdf-grid="${cardIdx}"]`);
                if (!grid) break;
                const items = grid.querySelectorAll('.page-thumb-item');
                if (!items[pageIdx]) break;
                const wrap = items[pageIdx].querySelector('.page-thumb-img-wrap');
                if (!wrap) break;
                const existing = wrap.querySelector('img');
                if (existing) existing.src = dataUrl;
                else {
                  const img = document.createElement('img');
                  img.src = dataUrl;
                  img.alt = 'Page ' + (pageIdx + 1);
                  wrap.innerHTML = '';
                  wrap.appendChild(img);
                }
              } catch (e) { /* DOM may have been re-rendered */ }
            }
            break; // found the file, exit loop
          }
        }
      }, mergeFileId);
      pdfFiles.push(entry);
    }
    undo.reset();
    undo.push(getState());
    renderMergeCards();
    updateMergeUI();
    toast(`Loaded ${pfs.length} PDF(s)`, 'success');
  }

  undo = new UndoRedoManager();
  undo.bind('merge-undo', 'merge-redo');
  undo.onChange = (state) => applyState(state);

  /* Export */
  document.getElementById('merge-start').addEventListener('click', async () => {
    const all = allPages();
    if (all.length < 2) { toast('Need at least 2 pages to merge', 'error'); return; }
    const outName = document.getElementById('merge-output-name').value.trim();
    document.getElementById('merge-start').disabled = true;

    try {
      await pdflib();
      const { PDFDocument } = PDFLib;
      const newDoc = await PDFDocument.create();

      for (const p of all) {
        const f = pdfFiles[p._pdfIdx];
        if (!f || !f.data) continue;
        const src = await PDFDocument.load(f.data);
        const [cp] = await newDoc.copyPages(src, [p.pageNum - 1]);
        if (p.rotation) cp.setRotation(PDFLib.degrees(cp.getRotation().angle + p.rotation));
        newDoc.addPage(cp);
      }

      const bytes = await newDoc.save();
      const name = outName || defaultFilename(pdfFiles[0]?.file?.name || 'merged', '.pdf');
      dlBlob(new Blob([bytes], {type:'application/pdf'}), name);
      toast('PDFs merged successfully!', 'success');
      resetTool('merge');
    } catch (err) {
      toast('Merge failed: ' + err.message, 'error');
      console.error(err);
    } finally {
      document.getElementById('merge-start').disabled = false;
    }
  });
}

/* ===========================================================
   IMAGE TO PDF
   =========================================================== */
function initImg2PdfTool() {
  let images = [];
  let selectedFilter = 'original';
  let selectedImgIdx = null; // for manual crop
  let cropStart = null; // for manual crop drag
  let undo;
  const gridId = 'img2pdf-grid';

  function getState() {
    return images.map(img => ({
      name: img.file.name,
      rotation: img.rotation,
      selected: img.selected,
      filter: img.filter || 'original',
      crop: img.crop || null
    }));
  }
  function applyState(state) {
    images = state.map(s => {
      const ex = images.find(e => e.file.name === s.name);
      return { ...ex, ...s };
    });
    renderImageGrid();
    updateImgUI();
  }

  function renderImageGrid() {
    const el = document.getElementById(gridId);
    if (!el) return;
    el.innerHTML = images.map((img, i) => {
      const rot = img.rotation || 0;
      let filterCss = '';
      switch (img.filter || 'original') {
        case 'enhance': filterCss = 'contrast(1.15) saturate(1.1) brightness(1.05)'; break;
        case 'scan': filterCss = 'contrast(1.3) brightness(1.1) saturate(0.9)'; break;
        case 'bw': filterCss = 'grayscale(1) contrast(1.2) brightness(1.05)'; break;
        default: filterCss = '';
      }
      const cropStyle = img.crop ? `;clip-path:inset(${img.crop.t*100}% ${(1-img.crop.r)*100}% ${(1-img.crop.b)*100}% ${img.crop.l*100}%)` : '';
      return `<div class="img-grid-item${img.selected ? ' selected' : ''}" data-idx="${i}" draggable="true">
        <div class="img-check">${img.selected ? '✓' : ''}</div>
        <button class="img-rot-btn page-thumb-rot-cw" data-idx="${i}" title="Rotate CW">↻</button>
        <button class="img-rot-btn page-thumb-rot-ccw" data-idx="${i}" title="Rotate CCW">↺</button>
        <div class="img-thumb-wrap">
          <img src="${img.dataUrl}" alt="${img.file.name}" style="transform:rotate(${rot}deg);filter:${filterCss}${cropStyle}">
        </div>
        <div class="img-label">${img.file.name.substring(0, 15)}</div>
      </div>`;
    }).join('');

    el.querySelectorAll('.img-grid-item').forEach(item => {
      const idx = parseInt(item.dataset.idx, 10);
      item.addEventListener('click', (e) => {
        if (e.target.closest('.page-thumb-rot-cw') || e.target.closest('.page-thumb-rot-ccw')) return;
        showImagePreview(idx);
      });
      // Rotate buttons
      item.querySelector('.page-thumb-rot-cw')?.addEventListener('click', (e) => {
        e.stopPropagation();
        images[idx].rotation = (images[idx].rotation || 0) + 90;
        if (selectedImgIdx === idx) {
          document.getElementById('img2pdf-preview-img').style.transform = 'rotate('+images[idx].rotation+'deg)';
        }
        undo.push(getState()); renderImageGrid();
      });
      item.querySelector('.page-thumb-rot-ccw')?.addEventListener('click', (e) => {
        e.stopPropagation();
        images[idx].rotation = (images[idx].rotation || 0) - 90;
        if (selectedImgIdx === idx) {
          document.getElementById('img2pdf-preview-img').style.transform = 'rotate('+images[idx].rotation+'deg)';
        }
        undo.push(getState()); renderImageGrid();
      });
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
        item.classList.add('dragging');
      });
      item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => {
        e.preventDefault(); item.classList.remove('drag-over');
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(from) && from !== idx) {
          const [m] = images.splice(from, 1);
          images.splice(idx, 0, m);
          undo.push(getState()); renderImageGrid();
        }
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
    });
  }

  function showImagePreview(idx) {
    const img = images[idx];
    if (!img) return;
    selectedImgIdx = idx;
    const area = document.getElementById('img2pdf-preview-area');
    const imgEl = document.getElementById('img2pdf-preview-img');
    area.classList.remove('hidden');
    imgEl.src = img.dataUrl;
    
    // Toggle selection for preview
    images.forEach((i, n) => { i.selected = n === idx; });
    renderImageGrid();
    
    // Hide crop overlay initially
    document.getElementById('img2pdf-crop-overlay').classList.add('hidden');
  }

  function updateImgUI() {
    const tb = document.getElementById('img2pdf-toolbar');
    if (tb) tb.classList.toggle('hidden', images.length === 0);
    const ub = document.getElementById('img2pdf-undo-bar');
    if (ub) ub.classList.toggle('hidden', images.length === 0);
    const opts = document.getElementById('img2pdf-options');
    if (opts) opts.classList.toggle('hidden', images.length === 0);
    const area = document.getElementById('img2pdf-preview-area');
    if (images.length === 0 && area) area.classList.add('hidden');
    const cnt = document.getElementById('img2pdf-count');
    if (cnt) cnt.textContent = images.length + ' images';
    const btn = document.getElementById('img2pdf-start');
    btn.disabled = images.length === 0;
  }

  /* Dropzone */
  const dz = document.getElementById('img2pdf-dropzone');
  const inp = document.getElementById('img2pdf-file-input');
  dz.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => handleImgFiles(Array.from(inp.files)));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleImgFiles(Array.from(e.dataTransfer.files)); });

  async function handleImgFiles(files) {
    const imgs = files.filter(f => f.type.startsWith('image/'));
    if (!imgs.length) { toast('Please select image files', 'error'); return; }
    const batchSize = 5;
    for (let i = 0; i < imgs.length; i += batchSize) {
      const batch = imgs.slice(i, i + batchSize);
      for (const file of batch) {
        const data = await file.arrayBuffer();
        const dataUrl = URL.createObjectURL(file);
        images.push({
          file, data, dataUrl,
          rotation: 0, selected: false,
          filter: 'original', crop: null
        });
      }
      // Yield to main thread after each batch
      if (i + batchSize < imgs.length) {
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      }
    }
    undo.reset();
    undo.push(getState());
    renderImageGrid();
    updateImgUI();
    toast(`Loaded ${imgs.length} images`, 'success');
  }

  /* Undo/Redo */
  undo = new UndoRedoManager();
  undo.bind('img2pdf-undo', 'img2pdf-redo');
  undo.onChange = (state) => applyState(state);

  /* Toolbar actions */
  document.querySelector('.img-rotate-cw-all')?.addEventListener('click', () => {
    if (!images.length) return;
    const sel = images.filter(i => i.selected);
    (sel.length ? sel : images).forEach(i => { i.rotation = (i.rotation || 0) + 90; });
    undo.push(getState()); renderImageGrid();
    // Refresh preview if open
    if (selectedImgIdx !== null && images[selectedImgIdx]) {
      document.getElementById('img2pdf-preview-img').style.transform = 'rotate('+images[selectedImgIdx].rotation+'deg)';
    }
  });
  document.querySelector('.img-rotate-ccw-all')?.addEventListener('click', () => {
    if (!images.length) return;
    const sel = images.filter(i => i.selected);
    (sel.length ? sel : images).forEach(i => { i.rotation = (i.rotation || 0) - 90; });
    undo.push(getState()); renderImageGrid();
    if (selectedImgIdx !== null && images[selectedImgIdx]) {
      document.getElementById('img2pdf-preview-img').style.transform = 'rotate('+images[selectedImgIdx].rotation+'deg)';
    }
  });
  document.querySelector('.img-delete-selected')?.addEventListener('click', () => {
    images = images.filter(i => !i.selected);
    if (selectedImgIdx !== null && !images[selectedImgIdx]) {
      document.getElementById('img2pdf-preview-area').classList.add('hidden');
      selectedImgIdx = null;
    }
    undo.push(getState()); renderImageGrid(); updateImgUI();
  });

  /* Auto Crop */
  document.querySelector('.img-crop-auto')?.addEventListener('click', async () => {
    if (!images.length) { toast('No images to crop', 'error'); return; }
    toast('Auto cropping all images...');
    for (let i = 0; i < images.length; i++) {
      const img = await autoCropImage(images[i]);
      if (img) images[i] = img;
    }
    undo.push(getState());
    renderImageGrid();
    // Refresh preview
    if (selectedImgIdx !== null && images[selectedImgIdx]) {
      document.getElementById('img2pdf-preview-img').src = images[selectedImgIdx].dataUrl;
    }
    toast('Auto crop complete!', 'success');
  });

  async function autoCropImage(img) {
    try {
      const imgEl = new Image();
      const loaded = new Promise((res, rej) => { imgEl.onload = res; imgEl.onerror = rej; });
      imgEl.src = img.dataUrl;
      await loaded;
      
      // Create a canvas to analyze
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      c.width = imgEl.naturalWidth;
      c.height = imgEl.naturalHeight;
      ctx.drawImage(imgEl, 0, 0);
      
      const imageData = ctx.getImageData(0, 0, c.width, c.height);
      const data = imageData.data;
      const w = c.width, h = c.height;
      
      // Find content bounds by looking for non-white/non-black edges
      // Simple algorithm: detect variance from background
      let top = 0, bottom = h, left = 0, right = w;
      const threshold = 30;
      const margin = Math.min(w, h) * 0.02; // ~2% safety margin
      
      // Sample pixels to find content boundaries
      const step = Math.max(1, Math.floor(Math.min(w, h) / 200));
      
      // Top edge
      for (let y = 0; y < h * 0.5; y += step) {
        let hasContent = false;
        for (let x = 0; x < w; x += step) {
          const idx = (y * w + x) * 4;
          const r = data[idx], g = data[idx+1], b = data[idx+2];
          const lum = 0.299*r + 0.587*g + 0.114*b;
          if (Math.abs(lum - 255) > threshold && Math.abs(lum - 0) > threshold) {
            hasContent = true; break;
          }
        }
        if (hasContent) { top = y; break; }
      }
      
      // Bottom edge
      for (let y = h - 1; y > h * 0.5; y -= step) {
        let hasContent = false;
        for (let x = 0; x < w; x += step) {
          const idx = (y * w + x) * 4;
          const r = data[idx], g = data[idx+1], b = data[idx+2];
          const lum = 0.299*r + 0.587*g + 0.114*b;
          if (Math.abs(lum - 255) > threshold && Math.abs(lum - 0) > threshold) {
            hasContent = true; break;
          }
        }
        if (hasContent) { bottom = y; break; }
      }
      
      // Left edge
      for (let x = 0; x < w * 0.5; x += step) {
        let hasContent = false;
        for (let y = top; y < bottom; y += step) {
          const idx = (y * w + x) * 4;
          const r = data[idx], g = data[idx+1], b = data[idx+2];
          const lum = 0.299*r + 0.587*g + 0.114*b;
          if (Math.abs(lum - 255) > threshold && Math.abs(lum - 0) > threshold) {
            hasContent = true; break;
          }
        }
        if (hasContent) { left = x; break; }
      }
      
      // Right edge
      for (let x = w - 1; x > w * 0.5; x -= step) {
        let hasContent = false;
        for (let y = top; y < bottom; y += step) {
          const idx = (y * w + x) * 4;
          const r = data[idx], g = data[idx+1], b = data[idx+2];
          const lum = 0.299*r + 0.587*g + 0.114*b;
          if (Math.abs(lum - 255) > threshold && Math.abs(lum - 0) > threshold) {
            hasContent = true; break;
          }
        }
        if (hasContent) { right = x; break; }
      }
      
      // Apply safety margin
      const mX = Math.max(margin, w * 0.01);
      const mY = Math.max(margin, h * 0.01);
      top = Math.max(0, top - mY);
      bottom = Math.min(h, bottom + mY);
      left = Math.max(0, left - mX);
      right = Math.min(w, right + mX);
      
      // Store crop as percentages
      img.crop = {
        t: top / h,
        b: bottom / h,
        l: left / w,
        r: right / w
      };
      
      return img;
    } catch (e) {
      console.error('Auto crop failed:', e);
      toast('Auto crop failed for ' + img.file.name, 'error');
      return img;
    }
  }

  /* Manual Crop */
  document.querySelector('.img-crop-manual')?.addEventListener('click', () => {
    if (selectedImgIdx === null || !images[selectedImgIdx]) {
      toast('Click on an image first to select it', 'error');
      return;
    }
    const overlay = document.getElementById('img2pdf-crop-overlay');
    const frame = document.getElementById('crop-frame');
    overlay.classList.remove('hidden');
    
    // Set initial crop frame to cover ~90% of the image
    const container = document.querySelector('.img-preview-container');
    const cRect = container.getBoundingClientRect();
    const margin = 20; // px
    frame.style.left = margin + 'px';
    frame.style.top = margin + 'px';
    frame.style.width = (cRect.width - margin*2) + 'px';
    frame.style.height = (cRect.height - margin*2) + 'px';
    
    // Make frame draggable
    makeCropDraggable(frame, container);
  });

  function makeCropDraggable(frame, container) {
    let isDragging = false, isResizing = false;
    let startX, startY, startRect;
    let resizeHandle = null;

    const onStart = (e, handle) => {
      isDragging = handle === 'frame';
      isResizing = !!handle && handle !== 'frame';
      resizeHandle = handle;
      startX = e.clientX || e.touches?.[0]?.clientX || 0;
      startY = e.clientY || e.touches?.[0]?.clientY || 0;
      startRect = frame.getBoundingClientRect();
      
      const onMove = (ev) => {
        ev.preventDefault();
        const cx = ev.clientX || ev.touches?.[0]?.clientX || 0;
        const cy = ev.clientY || ev.touches?.[0]?.clientY || 0;
        const dx = cx - startX;
        const dy = cy - startY;
        const cRect = container.getBoundingClientRect();
        const minSize = 30;
        
        if (isResizing && resizeHandle) {
          let top = startRect.top - cRect.top;
          let left = startRect.left - cRect.left;
          let width = startRect.width;
          let height = startRect.height;
          
          if (resizeHandle.includes('e')) { width = Math.max(minSize, startRect.width + dx); }
          if (resizeHandle.includes('w')) { 
            const newLeft = Math.max(0, startRect.left - cRect.top + dx);
            width = Math.max(minSize, startRect.right - cRect.left - newLeft);
            left = newLeft;
          }
          if (resizeHandle.includes('s')) { height = Math.max(minSize, startRect.height + dy); }
          if (resizeHandle.includes('n')) {
            const newTop = Math.max(0, startRect.top - cRect.top + dy);
            height = Math.max(minSize, startRect.bottom - cRect.top - newTop);
            top = newTop;
          }
          
          frame.style.left = left + 'px';
          frame.style.top = top + 'px';
          frame.style.width = width + 'px';
          frame.style.height = height + 'px';
        } else if (isDragging) {
          const newLeft = Math.max(0, Math.min(cRect.width - startRect.width, startRect.left - cRect.left + dx));
          const newTop = Math.max(0, Math.min(cRect.height - startRect.height, startRect.top - cRect.top + dy));
          frame.style.left = newLeft + 'px';
          frame.style.top = newTop + 'px';
        }
      };
      
      const onEnd = () => {
        isDragging = false;
        isResizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
      };
      
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    };

    // Frame drag
    frame.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('crop-handle')) return;
      onStart(e, 'frame');
    });
    frame.addEventListener('touchstart', (e) => {
      if (e.target.classList.contains('crop-handle')) return;
      onStart(e, 'frame');
    }, { passive: false });

    // Handle drag
    frame.querySelectorAll('.crop-handle').forEach(h => {
      const dir = h.className.split('-').pop();
      h.addEventListener('mousedown', (e) => { e.stopPropagation(); onStart(e, dir); });
      h.addEventListener('touchstart', (e) => { e.stopPropagation(); onStart(e, dir); }, { passive: false });
    });
  }

  /* Apply Crop */
  document.getElementById('img2pdf-crop-apply')?.addEventListener('click', () => {
    if (selectedImgIdx === null || !images[selectedImgIdx]) return;
    const frame = document.getElementById('crop-frame');
    const container = document.querySelector('.img-preview-container');
    const cRect = container.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();
    
    const crop = {
      l: Math.max(0, (fRect.left - cRect.left) / cRect.width),
      t: Math.max(0, (fRect.top - cRect.top) / cRect.height),
      r: Math.min(1, (fRect.right - cRect.left) / cRect.width),
      b: Math.min(1, (fRect.bottom - cRect.top) / cRect.height)
    };
    
    images[selectedImgIdx].crop = crop;
    document.getElementById('img2pdf-crop-overlay').classList.add('hidden');
    undo.push(getState());
    renderImageGrid();
    toast('Crop applied', 'success');
  });

  document.getElementById('img2pdf-crop-cancel')?.addEventListener('click', () => {
    document.getElementById('img2pdf-crop-overlay').classList.add('hidden');
  });

  /* Filter buttons */
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedFilter = btn.dataset.filter;
      
      // Apply to selected images or all if none selected
      const sel = images.filter(i => i.selected);
      (sel.length ? sel : images).forEach(i => { i.filter = selectedFilter; });
      renderImageGrid();
      // Refresh preview if open
      if (selectedImgIdx !== null && images[selectedImgIdx]) {
        const filterCss = getFilterCss(selectedFilter);
        document.getElementById('img2pdf-preview-img').style.filter = filterCss;
      }
    });
  });

  function getFilterCss(filter) {
    switch (filter) {
      case 'enhance': return 'contrast(1.15) saturate(1.1) brightness(1.05)';
      case 'scan': return 'contrast(1.3) brightness(1.1) saturate(0.9)';
      case 'bw': return 'grayscale(1) contrast(1.2) brightness(1.05)';
      default: return '';
    }
  }

  /* Preview PDF */
  document.getElementById('img2pdf-preview-btn')?.addEventListener('click', async () => {
    if (!images.length) return;
    const wrap = document.getElementById('img2pdf-preview-wrap');
    const frame = document.getElementById('img2pdf-preview-frame');
    const size = document.getElementById('img2pdf-pagesize').value;
    wrap.classList.remove('hidden');

    try {
      await pdflib();
      const { PDFDocument } = PDFLib;
      const doc = await PDFDocument.create();

      for (const img of images) {
        let buf = await img.file.arrayBuffer();
        
        // Apply crop if exists
        if (img.crop) {
          buf = await applyCropToBuffer(img, buf);
        }
        
        let image;
        if (img.file.type === 'image/png') image = await doc.embedPng(buf);
        else image = await doc.embedJpg(buf);
        const { width: iw, height: ih } = image.scale(1);

        let pw, ph;
        if (size === 'A4') { pw = 595.28; ph = 841.89; }
        else if (size === 'Letter') { pw = 612; ph = 792; }
        else { pw = iw; ph = ih; }

        const page = doc.addPage([pw, ph]);
        if (img.rotation) page.setRotation(PDFLib.degrees(img.rotation));

        const scale = Math.min(pw / iw, ph / ih) * 0.9;
        const dw = iw * scale, dh = ih * scale;
        page.drawImage(image, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      }

      const bytes = await doc.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      frame.src = URL.createObjectURL(blob);
    } catch (err) {
      toast('Preview failed: ' + err.message, 'error');
    }
  });

  async function applyCropToBuffer(img, originalBuf) {
    return new Promise((resolve) => {
      const imageEl = new Image();
      imageEl.onload = () => {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        const iw = imageEl.naturalWidth;
        const ih = imageEl.naturalHeight;
        const crop = img.crop;
        const sw = (crop.r - crop.l) * iw;
        const sh = (crop.b - crop.t) * ih;
        const sx = crop.l * iw;
        const sy = crop.t * ih;
        c.width = sw;
        c.height = sh;
        ctx.drawImage(imageEl, sx, sy, sw, sh, 0, 0, sw, sh);
        c.toBlob((blob) => resolve(blob.arrayBuffer()), img.file.type, 0.95);
      };
      imageEl.src = URL.createObjectURL(new Blob([originalBuf], { type: img.file.type }));
    });
  }

  /* Export */
  document.getElementById('img2pdf-start').addEventListener('click', async () => {
    if (!images.length) return;
    const outName = document.getElementById('img2pdf-output-name').value.trim();
    const size = document.getElementById('img2pdf-pagesize').value;
    document.getElementById('img2pdf-start').disabled = true;

    try {
      await pdflib();
      const { PDFDocument } = PDFLib;
      const doc = await PDFDocument.create();

      for (const img of images) {
        let buf = await img.file.arrayBuffer();
        
        // Apply crop if exists
        if (img.crop) {
          buf = await applyCropToBuffer(img, buf);
        }
        
        let image;
        if (img.file.type === 'image/png') image = await doc.embedPng(buf);
        else image = await doc.embedJpg(buf);
        const { width: iw, height: ih } = image.scale(1);

        let pw, ph;
        if (size === 'A4') { pw = 595.28; ph = 841.89; }
        else if (size === 'Letter') { pw = 612; ph = 792; }
        else { pw = iw; ph = ih; }

        const page = doc.addPage([pw, ph]);
        if (img.rotation) page.setRotation(PDFLib.degrees(img.rotation));

        const scale = Math.min(pw / iw, ph / ih) * 0.9;
        const dw = iw * scale, dh = ih * scale;
        page.drawImage(image, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      }

      const bytes = await doc.save();
      const name = outName || 'IstServices.pdf';
      dlBlob(new Blob([bytes], {type:'application/pdf'}), name);
      toast('PDF created successfully!', 'success');
      resetTool('img2pdf');
    } catch (err) {
      toast('Failed: ' + err.message, 'error');
      console.error(err);
    } finally {
      document.getElementById('img2pdf-start').disabled = false;
    }
  });
}

function initCompressTool() {
  let pdfFile = null;
  let pdfData = null;
  let level = 'high';

  const dz = document.getElementById('compress-dropzone');
  const inp = document.getElementById('compress-file-input');
  dz.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => handleFile(Array.from(inp.files)));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFile(Array.from(e.dataTransfer.files)); });

  async function handleFile(files) {
    if (!files.length) return;
    pdfFile = files[0];
    pdfData = await pdfFile.arrayBuffer();
    document.getElementById('compress-info').classList.remove('hidden');
    document.getElementById('compress-start').disabled = false;
    document.getElementById('compress-original-size').textContent = fmtBytes(pdfFile.size);
    updateEstimates();
  }

  function updateEstimates() {
    const est = { high: 0.45, medium: 0.65, low: 0.85 };
    const pct = { high: '55%', medium: '35%', low: '15%' };
    const saved = Math.round(pdfFile.size * (1 - est[level]));
    document.getElementById('compress-estimated-size').textContent = fmtBytes(Math.round(pdfFile.size * est[level]));
    document.getElementById('compress-savings').textContent = '-' + fmtBytes(saved) + ' (' + pct[level] + ')';
  }

  document.querySelectorAll('.compress-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.compress-level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      level = btn.dataset.level;
      if (pdfFile) updateEstimates();
    });
  });

  document.getElementById('compress-start').addEventListener('click', async () => {
    if (!pdfFile) return;
    document.getElementById('compress-start').disabled = true;
    document.getElementById('compress-progress').classList.remove('hidden');

    try {
      await pdflib();
      const { PDFDocument } = PDFLib;
      const doc = await PDFDocument.load(pdfData);

      let opts = { useObjectStreams: true, objectsPerTick: 100 };
      if (level === 'high') opts.objectsPerTick = 50;
      else if (level === 'low') opts.objectsPerTick = 200;

      document.getElementById('compress-progress-text').textContent = 'Compressing...';
      document.getElementById('compress-progress-fill').style.width = '60%';

      const bytes = await doc.save(opts);
      document.getElementById('compress-progress-fill').style.width = '100%';
      document.getElementById('compress-progress-text').textContent = 'Done!';

      const compressedBlob = new Blob([bytes], { type: 'application/pdf' });
      const outName = document.getElementById('compress-output-name').value.trim() || defaultFilename(pdfFile.name, '-compressed.pdf');
      dlBlob(compressedBlob, outName);

      const ratio = pdfFile.size ? Math.round((1 - bytes.length / pdfFile.size) * 100) : 0;
      toast(`Compressed: ${fmtBytes(pdfFile.size)} → ${fmtBytes(bytes.length)} (${ratio}% reduction)`, 'success');
      resetTool('compress');
    } catch (err) {
      toast('Compression failed: ' + err.message, 'error');
    } finally {
      document.getElementById('compress-start').disabled = false;
      setTimeout(() => document.getElementById('compress-progress').classList.add('hidden'), 2000);
    }
  });
}

/* ===========================================================
   PDF TO IMAGE
   =========================================================== */
function initPdf2ImgTool() {
  let pdfFile = null;
  const dz = document.getElementById('pdf2img-dropzone');
  const inp = document.getElementById('pdf2img-file-input');
  const scaleInp = document.getElementById('pdf2img-scale');
  const scaleVal = document.getElementById('pdf2img-scale-value');
  const formatSel = document.getElementById('pdf2img-format');

  scaleInp.addEventListener('input', () => { scaleVal.textContent = scaleInp.value + '%'; });

  dz.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => handleFile(Array.from(inp.files)));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); handleFile(Array.from(e.dataTransfer.files)); });

  function handleFile(files) {
    if (!files.length) return;
    pdfFile = files[0];
    document.getElementById('pdf2img-options').classList.remove('hidden');
    document.getElementById('pdf2img-start').disabled = false;
  }

  document.getElementById('pdf2img-start').addEventListener('click', async () => {
    if (!pdfFile) return;
    document.getElementById('pdf2img-start').disabled = true;
    document.getElementById('pdf2img-progress').classList.remove('hidden');

    try {
      const scale = parseInt(scaleInp.value, 10) / 100;
      const format = formatSel.value;
      const outName = document.getElementById('pdf2img-output-name').value.trim() || defaultFilename(pdfFile.name, '');

      await pdfjs();
      const data = await pdfFile.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data }).promise;
      const total = pdf.numPages;
      const images = [];

      for (let i = 1; i <= total; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        images.push(c.toDataURL(format, 0.95));
        document.getElementById('pdf2img-progress-fill').style.width = `${(i/total)*90}%`;
        document.getElementById('pdf2img-progress-text').textContent = `Rendering page ${i} of ${total}...`;
      }

      await jszip();
      const JSZip = window.JSZip;
      const zip = new JSZip();
      const ext = format === 'image/png' ? '.png' : '.jpg';
      images.forEach((img, i) => {
        zip.file(`${outName}-page-${i+1}${ext}`, img.split(',')[1], { base64: true });
      });

      document.getElementById('pdf2img-progress-text').textContent = 'Creating ZIP...';
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      document.getElementById('pdf2img-progress-fill').style.width = '100%';
      document.getElementById('pdf2img-progress-text').textContent = 'Done!';

      dlBlob(zipBlob, outName + '-images.zip');
      toast('PDF converted to images!', 'success');
      resetTool('pdf2img');
    } catch (err) {
      toast('Conversion failed: ' + err.message, 'error');
    } finally {
      document.getElementById('pdf2img-start').disabled = false;
      setTimeout(() => document.getElementById('pdf2img-progress').classList.add('hidden'), 2000);
    }
  });
}

/* ===========================================================
   PROTECT PDF
   =========================================================== */
function initProtectTool() {
  setupDropzoneSimple('protect', () => {
    document.getElementById('protect-options').classList.remove('hidden');
    document.getElementById('protect-start').disabled = false;
  });
  document.getElementById('protect-start').addEventListener('click', async () => {
    const pass = document.getElementById('protect-password').value;
    const conf = document.getElementById('protect-confirm').value;
    const err = document.getElementById('protect-error');
    if (!pass || pass.length < 4) { err.textContent = 'Password must be at least 4 characters'; err.classList.remove('hidden'); return; }
    if (pass !== conf) { err.textContent = 'Passwords do not match'; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    document.getElementById('protect-start').disabled = true;
    document.getElementById('protect-progress').classList.remove('hidden');
    try {
      await pdflib();
      const pf = _toolFiles['protect'];
      if (!pf) { toast('No file selected', 'error'); document.getElementById('protect-start').disabled = false; return; }
      const buf = await pf.arrayBuffer();
      const doc = await PDFLib.PDFDocument.load(buf);
      const bytes = await doc.save({ ownerPassword: pass, userPassword: pass });
      dlBlob(new Blob([bytes], {type:'application/pdf'}), pf.name.replace('.pdf','-protected.pdf'));
      toast('PDF protected!', 'success');
      resetTool('protect');
    } catch (err) { toast('Failed: '+err.message, 'error'); }
    finally { document.getElementById('protect-start').disabled = false; setTimeout(() => document.getElementById('protect-progress').classList.add('hidden'), 2000); }
  });
}

/* ===========================================================
   WATERMARK PDF
   =========================================================== */
function initWatermarkTool() {
  const opacityInp = document.getElementById('watermark-opacity');
  const opacityVal = document.getElementById('watermark-opacity-value');
  opacityInp.addEventListener('input', () => { opacityVal.textContent = Math.round(opacityInp.value * 100) + '%'; });
  setupDropzoneSimple('watermark', () => {
    document.getElementById('watermark-options').classList.remove('hidden');
    document.getElementById('watermark-start').disabled = false;
  });
  document.getElementById('watermark-start').addEventListener('click', async () => {
    const text = document.getElementById('watermark-text').value.trim();
    if (!text) { toast('Enter watermark text', 'error'); return; }
    document.getElementById('watermark-start').disabled = true;
    document.getElementById('watermark-progress').classList.remove('hidden');
    try {
      await pdflib();
      const pf = _toolFiles['watermark'];
      if (!pf) { toast('No file selected', 'error'); document.getElementById('watermark-start').disabled = false; return; }
      const buf = await pf.arrayBuffer();
      const doc = await PDFLib.PDFDocument.load(buf);
      const pages = doc.getPages();
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const opacity = parseFloat(opacityInp.value);
      const pos = document.getElementById('watermark-position').value;
      for (let i = 0; i < pages.length; i++) {
        const pg = pages[i];
        const { width, height } = pg.getSize();
        const sz = Math.min(width, height) * 0.04;
        let x, y, rot;
        switch (pos) {
          case 'diagonal': x = width/2; y = height/2; rot = 45; break;
          case 'top-left': x = width*0.08; y = height*0.92; rot = 0; break;
          case 'bottom-right': x = width*0.92; y = height*0.08; rot = 0; break;
          default: x = width/2; y = height/2; rot = 0;
        }
        pg.drawText(text, { x, y, size: sz, font, color: PDFLib.rgb(0.5,0.5,0.5), opacity, rotate: rot ? PDFLib.degrees(rot) : undefined });
        document.getElementById('watermark-progress-fill').style.width = `${((i+1)/pages.length)*90}%`;
      }
      const bytes = await doc.save();
      dlBlob(new Blob([bytes], {type:'application/pdf'}), pf.name.replace('.pdf','-watermarked.pdf'));
      toast('Watermark added!', 'success');
      resetTool('watermark');
    } catch (err) { toast('Failed: '+err.message, 'error'); }
    finally { document.getElementById('watermark-start').disabled = false; setTimeout(() => document.getElementById('watermark-progress').classList.add('hidden'), 2000); }
  });
}

/* ===========================================================
   PAGE NUMBERS
   =========================================================== */
function initPageNumTool() {
  setupDropzoneSimple('pagenum', () => {
    document.getElementById('pagenum-options').classList.remove('hidden');
    document.getElementById('pagenum-start').disabled = false;
  });
  document.getElementById('pagenum-start').addEventListener('click', async () => {
    document.getElementById('pagenum-start').disabled = true;
    document.getElementById('pagenum-progress').classList.remove('hidden');
    try {
      await pdflib();
      const pf = _toolFiles['pagenum'];
      if (!pf) { toast('No file selected', 'error'); document.getElementById('pagenum-start').disabled = false; return; }
      const buf = await pf.arrayBuffer();
      const doc = await PDFLib.PDFDocument.load(buf);
      const pages = doc.getPages();
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const pos = document.getElementById('pagenum-position').value;
      const startNum = parseInt(document.getElementById('pagenum-start').value, 10) || 1;
      for (let i = 0; i < pages.length; i++) {
        const pg = pages[i];
        const { width, height } = pg.getSize();
        const num = startNum + i;
        const sz = Math.min(width, height) * 0.025;
        let x, y;
        switch (pos) {
          case 'bottom-left': x = width*0.08; y = height*0.06; break;
          case 'bottom-right': x = width*0.92; y = height*0.06; break;
          case 'top-center': x = width/2; y = height*0.94; break;
          case 'top-left': x = width*0.08; y = height*0.94; break;
          case 'top-right': x = width*0.92; y = height*0.94; break;
          default: x = width/2; y = height*0.06;
        }
        pg.drawText(String(num), { x, y, size: sz, font, color: PDFLib.rgb(0.3,0.3,0.3) });
        document.getElementById('pagenum-progress-fill').style.width = `${((i+1)/pages.length)*90}%`;
      }
      const bytes = await doc.save();
      dlBlob(new Blob([bytes], {type:'application/pdf'}), pf.name.replace('.pdf','-numbered.pdf'));
      toast('Page numbers added!', 'success');
      resetTool('pagenum');
    } catch (err) { toast('Failed: '+err.message, 'error'); }
    finally { document.getElementById('pagenum-start').disabled = false; setTimeout(() => document.getElementById('pagenum-progress').classList.add('hidden'), 2000); }
  });
}

/* ===========================================================
   Dropzone Helper (simple single-file tools)
   =========================================================== */
const _toolFiles = {};

function setupDropzoneSimple(prefix, onFile) {
  try {
    const dz = document.getElementById(`${prefix}-dropzone`);
    const inp = document.getElementById(`${prefix}-file-input`);
    if (!dz || !inp) { console.warn('Dropzone not found:', prefix); return; }
    dz.addEventListener('click', () => inp.click());
    inp.addEventListener('change', () => {
      const files = Array.from(inp.files);
      if (files.length) { _toolFiles[prefix] = files[0]; if (onFile) onFile(); }
    });
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      if (files.length) { _toolFiles[prefix] = files[0]; if (onFile) onFile(); }
    });
  } catch (e) { console.warn('setupDropzoneSimple error:', prefix, e); }
}



/* ===========================================================
   Overlay Management
   =========================================================== */
const TOOLS = ['merge','split','compress','img2pdf','pdf2img','protect','watermark','pagenum'];
function openOverlay(tool) {
  const o = document.getElementById(`tool-overlay-${tool}`);
  if (o) o.classList.remove('hidden');
}
function closeAllOverlays() {
  TOOLS.forEach(t => {
    const o = document.getElementById(`tool-overlay-${t}`);
    if (o) o.classList.add('hidden');
  });
}

function resetTool(prefix) {
  const inp = document.getElementById(`${prefix}-file-input`);
  if (inp) inp.value = '';
  const list = document.getElementById(`${prefix}-file-list`);
  if (list) list.innerHTML = '';
  const opts = document.getElementById(`${prefix}-options`);
  if (opts) opts.classList.add('hidden');
  const editor = document.getElementById(`${prefix}-editor`);
  if (editor) editor.classList.add('hidden');
  const startBtn = document.getElementById(`${prefix}-start`);
  if (startBtn) startBtn.disabled = true;
  const progress = document.getElementById(`${prefix}-progress`);
  if (progress) progress.classList.add('hidden');
  const wrap = document.getElementById(`${prefix}-preview-wrap`);
  if (wrap) wrap.classList.add('hidden');
  const grid = document.getElementById(`${prefix}-pages-grid`);
  if (grid) grid.innerHTML = '';
  const imgGrid = document.getElementById(`${prefix}-grid`);
  if (imgGrid) imgGrid.innerHTML = '';
  const exportOpts = document.getElementById(`${prefix}-export-opts`);
  if (exportOpts) exportOpts.classList.add('hidden');
  const toolbar = document.getElementById(`${prefix}-toolbar`);
  if (toolbar) toolbar.classList.add('hidden');
  const undoBar = document.getElementById(`${prefix}-undo-bar`);
  if (undoBar) undoBar.classList.add('hidden');
  const cards = document.getElementById(`${prefix}-pdf-cards`);
  if (cards) cards.innerHTML = '';
  const outName = document.getElementById(`${prefix}-output-name`);
  if (outName) outName.value = '';

  const overlay = document.getElementById(`tool-overlay-${prefix}`);
  if (overlay) setTimeout(() => overlay.classList.add('hidden'), 200);
  delete _toolFiles[prefix];
}

/* ===========================================================
   Init
   =========================================================== */
function init() {
  /* Tool cards → overlay */
  document.querySelectorAll('.pdf-tool-card').forEach(card => {
    card.addEventListener('click', () => {
      try { openOverlay(card.dataset.tool); } catch (e) { console.error('Card click:', e); }
    });
  });

  /* Overlay close buttons */
  document.querySelectorAll('.tool-overlay-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const o = btn.closest('.tool-overlay');
      if (o) o.classList.add('hidden');
    });
  });

  /* Cancel buttons */
  document.querySelectorAll('.tool-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const o = btn.closest('.tool-overlay');
      if (o) o.classList.add('hidden');
    });
  });

  /* Click outside to close */
  document.querySelectorAll('.tool-overlay').forEach(o => {
    o.addEventListener('click', (e) => { if (e.target === o) o.classList.add('hidden'); });
  });

  /* Escape to close all */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllOverlays();
  });

  /* Ctrl+Z / Ctrl+Y for undo/redo */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      if (e.shiftKey) {
        // Redo
        document.querySelectorAll('.btn[id$="-redo"]:not(:disabled)').forEach(b => b.click());
      } else {
        document.querySelectorAll('.btn[id$="-undo"]:not(:disabled)').forEach(b => b.click());
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      document.querySelectorAll('.btn[id$="-redo"]:not(:disabled)').forEach(b => b.click());
    }
  });

  /* Init all tools — each wrapped to prevent one failure from breaking others */
  try { initMergeTool(); } catch (e) { console.error('Merge init:', e); }
  try { initSplitTool(); } catch (e) { console.error('Split init:', e); }
  try { initCompressTool(); } catch (e) { console.error('Compress init:', e); }
  try { initImg2PdfTool(); } catch (e) { console.error('Img2Pdf init:', e); }
  try { initPdf2ImgTool(); } catch (e) { console.error('Pdf2Img init:', e); }
  try { initProtectTool(); } catch (e) { console.error('Protect init:', e); }
  try { initWatermarkTool(); } catch (e) { console.error('Watermark init:', e); }
  try { initPageNumTool(); } catch (e) { console.error('PageNum init:', e); }
}

document.addEventListener('DOMContentLoaded', () => {
  try { init(); } catch (e) { console.error('PDF Tools init failed:', e); }
});
