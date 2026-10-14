// FileLinkManager - renderer logic
// Wrapped in IIFE: top-level consts must not collide with preload-injected
// globals such as window.api (global `const api` would throw SyntaxError).
(function () {
  'use strict';

  const api = window.api;
  const quickPaths = window.api.quickPaths;
  const $ = (id) => document.getElementById(id);

  const state = {
    currentDir: '',
    history: [],
    selected: new Set(),
    anchorPath: null, // Shift 连选的基准项
    canPaste: false,
    cutItems: new Set(),
    assocTarget: null,
    selectedAssoc: new Set(),
    drives: null, // cached once
    customQuick: [], // user-pinned quick-access folders [{ name, path }]
    hiddenQuick: [], // built-in quick entries the user removed (restore-able)
    // 全局设置（主进程 settings.json，启动时拉取）
    settings: null,
    // Bottom-left relationship graph panel (常驻；large 为放大态)
    graph: { large: false, data: null },
    loadingTimer: null,
    // 当前目录最近一次列表数据（切换视图/排序/缩放时无需重新请求）
    lastItems: [],
    lastAssoc: {},
    lastAssocIn: {},
    // 视图偏好（localStorage 持久化）
    view: loadViewPref()
  };

  // ---------- 视图偏好（网格/列表、图标大小、排序） ----------
  const VIEW_KEY = 'flm-view-v1';
  const ICON_MIN = 28, ICON_MAX = 96, ICON_STEP = 8;
  function loadViewPref() {
    const d = { mode: 'grid', iconSize: 44, sortKey: 'name', sortDir: 'asc' };
    try {
      const raw = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
      if (raw.mode === 'grid' || raw.mode === 'list') d.mode = raw.mode;
      if (Number.isFinite(raw.iconSize)) d.iconSize = Math.min(ICON_MAX, Math.max(ICON_MIN, raw.iconSize));
      if (['name', 'mtime', 'type', 'size'].includes(raw.sortKey)) d.sortKey = raw.sortKey;
      if (raw.sortDir === 'asc' || raw.sortDir === 'desc') d.sortDir = raw.sortDir;
    } catch { /* 首次使用或数据损坏时用默认值 */ }
    return d;
  }
  function saveViewPref() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(state.view)); } catch { /* 忽略 */ }
  }

  // ---------- File type icons ----------
  // 图片：简约线条图标（太阳 + 两座山），currentColor 随容器字号缩放
  const IMG_SVG = '<svg class="ic-img" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.6" y="3.6" width="18.8" height="16.8" rx="2.4"/><circle cx="8.6" cy="9" r="1.7" fill="currentColor" stroke="none"/><path d="M3.4 18.6 9 12.2l3 3.3 2.5-2.7 6.1 5.8"/></svg>';

  function iconFor(item) {
    if (item.isDir) return { cls: 'folder', ch: '📁' };
    const ext = item.ext;
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) return { cls: 'img', ch: '', svg: IMG_SVG };
    if (['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm'].includes(ext)) return { cls: 'vid', ch: '🎬' };
    if (['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'].includes(ext)) return { cls: 'aud', ch: '🎵' };
    if (['.pdf'].includes(ext)) return { cls: 'pdf', ch: '📕' };
    if (['.doc', '.docx'].includes(ext)) return { cls: 'doc', ch: '📘' };
    if (['.xls', '.xlsx', '.csv'].includes(ext)) return { cls: 'xls', ch: '📗' };
    if (['.ppt', '.pptx'].includes(ext)) return { cls: 'ppt', ch: '📙' };
    if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(ext)) return { cls: 'zip', ch: '🗜' };
    if (['.js', '.ts', '.json', '.py', '.go', '.c', '.cpp', '.java', '.rs', '.html', '.css', '.md'].includes(ext)) return { cls: 'code', ch: '⌨' };
    if (['.exe', '.msi', '.bat', '.cmd', '.ps1'].includes(ext)) return { cls: 'exe', ch: '⚙' };
    if (['.txt', '.log'].includes(ext)) return { cls: 'txt', ch: '📄' };
    return { cls: 'file', ch: '📃' };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function toast(msg, kind = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + kind;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = 'toast ' + kind; }, 2200);
  }

  // ---------- Loading overlay (avoids flicker for fast loads) ----------
  function showLoading(delayed = true) {
    hideLoading();
    if (delayed) {
      state.loadingTimer = setTimeout(() => $('loading-overlay').classList.add('show'), 150);
    } else {
      $('loading-overlay').classList.add('show');
    }
  }
  function hideLoading() {
    clearTimeout(state.loadingTimer);
    $('loading-overlay').classList.remove('show');
  }

  // ---------- Navigation ----------
  let firstLoad = true;
  async function navigate(dir, pushHistory = true) {
    if (!dir) return;
    // On first load the overlay is already visible from static HTML.
    if (!firstLoad) showLoading(true);
    firstLoad = false;
    let res;
    try {
      res = await api.dir.list(dir);
    } finally {
      hideLoading();
    }
    if (!res.ok) {
      toast('无法打开：' + res.error, 'error');
      return;
    }
    if (pushHistory && state.currentDir && state.currentDir !== dir) {
      state.history.push(state.currentDir);
    }
    state.currentDir = res.path;
    state.selected.clear();
    state.anchorPath = null;
    state.cutItems.clear();
    $('addr').value = res.path;
    renderGrid(res.items, res.assoc || {}, res.assocIn || {});
    // 记忆上次浏览目录（供“启动打开上次文件夹”使用）；最近访问按设置记录
    if (state.settings) api.settings.set({ lastDir: res.path }).then(s => { state.settings = s; }).catch(() => {});
    if (!state.settings || state.settings.recentEnabled) {
      api.recent.add(res.path).then(refreshRecent).catch(() => {});
    }
    refreshQuickActive();
    updateToolbar();
    setAssocTarget(null);
  }

  async function goBack() {
    if (!state.history.length) return;
    const prev = state.history.pop();
    await navigate(prev, false);
  }

  async function goUp() {
    if (!state.currentDir) return;
    const parent = await api.dir.parent(state.currentDir);
    if (parent === state.currentDir) return;
    await navigate(parent);
  }

  async function refresh() {
    if (state.currentDir) await navigate(state.currentDir, false);
  }

  // ---------- Render grid / list ----------
  // assocMap   = path -> outgoing link count (this item links to others)
  // assocInMap = path -> incoming reference count (others link to this item)
  function renderGrid(items, assocMap, assocInMap) {
    // 缓存原始数据，切换视图/排序/缩放时只重新渲染、不重新读盘
    state.lastItems = items || [];
    state.lastAssoc = assocMap || {};
    state.lastAssocIn = assocInMap || {};
    renderCurrentItems();
  }

  // 用当前视图偏好重新渲染已缓存的目录内容
  function renderCurrentItems() {
    const grid = $('file-grid');
    grid.innerHTML = '';
    const items = sortItems(state.lastItems);
    if (!items.length) {
      grid.innerHTML = '<div class="empty-list">这个文件夹是空的</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    // 关联数量标记可在设置中关闭
    const showBadge = !state.settings || state.settings.showAssocBadge !== false;
    for (const it of items) {
      frag.appendChild(buildFileItem(
        it,
        showBadge ? (state.lastAssoc[it.path] || 0) : 0,
        showBadge ? (state.lastAssocIn[it.path] || 0) : 0
      ));
    }
    grid.appendChild(frag);
  }

  // ---------- 排序：文件夹始终置顶，组内再按所选规则 ----------
  function sortItems(items) {
    const { sortKey, sortDir } = state.view;
    const dir = sortDir === 'asc' ? 1 : -1;
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }) * dir,
      mtime: (a, b) => ((a.mtime || 0) - (b.mtime || 0)) * dir,
      size: (a, b) => ((a.size || 0) - (b.size || 0)) * dir,
      // 文件夹先按名称；文件按扩展名分组，扩展名相同再按名称
      type: (a, b) => {
        const ta = typeLabel(a), tb = typeLabel(b);
        if (ta !== tb) return ta.localeCompare(tb, 'zh-Hans-CN') * dir;
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * dir;
      }
    }[sortKey];
    return items.slice().sort((a, b) => (a.isDir === b.isDir ? cmp(a, b) : a.isDir ? -1 : 1));
  }

  function fmtSize(bytes, isDir) {
    if (isDir) return '';
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
  }

  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function typeLabel(it) {
    if (it.isDir) return '文件夹';
    const ext = (it.ext || '').replace(/^\./, '').toUpperCase();
    const known = {
      JPG: 'JPEG 图像', JPEG: 'JPEG 图像', PNG: 'PNG 图像', GIF: 'GIF 图像', WEBP: 'WebP 图像', BMP: '位图图像', ICO: '图标文件',
      MP4: '视频', MKV: '视频', AVI: '视频', MOV: '视频', WMV: '视频', WEBM: '视频',
      MP3: '音频', WAV: '音频', FLAC: '音频', AAC: '音频', M4A: '音频', OGG: '音频',
      PDF: 'PDF 文档', DOC: 'Word 文档', DOCX: 'Word 文档', XLS: 'Excel 表格', XLSX: 'Excel 表格',
      PPT: 'PPT 演示文稿', PPTX: 'PPT 演示文稿', CSV: 'CSV 表格',
      ZIP: '压缩文件', '7Z': '压缩文件', RAR: '压缩文件', TAR: '压缩文件', GZ: '压缩文件',
      JS: 'JavaScript 文件', TS: 'TypeScript 文件', JSON: 'JSON 文件', PY: 'Python 文件',
      HTML: 'HTML 文件', CSS: '样式表', MD: 'Markdown 文件', TXT: '文本文档', LOG: '日志文件',
      EXE: '应用程序', MSI: '安装程序', BAT: '批处理文件', CMD: '命令脚本', PS1: 'PowerShell 脚本'
    };
    return ext ? (known[ext] || ext + ' 文件') : '文件';
  }

  function buildFileItem(it, assocCount, assocInCount) {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.dataset.path = it.path;
    el.dataset.name = it.name;
    el.dataset.isdir = it.isDir ? '1' : '0';
    // 可按住拖到其他文件夹（内部移动/复制，也可直接拖出到资源管理器）
    el.draggable = true;
    const ic = iconFor(it);
    // name-cell：网格态下角标相对整个 item 绝对定位；列表态下角标随名称内联排列
    el.innerHTML = `
      <div class="ic ${ic.cls}">${ic.svg || ic.ch}</div>
      <div class="name-cell">
        <div class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
      </div>
      <span class="col col-date">${fmtDate(it.mtime)}</span>
      <span class="col col-type">${escapeHtml(typeLabel(it))}</span>
      <span class="col col-size">${fmtSize(it.size, it.isDir)}</span>
    `;
    const nameCell = el.querySelector('.name-cell');
    // Incoming reference: another item associates TO this one — link symbol
    if (assocInCount > 0) {
      const inBadge = document.createElement('span');
      inBadge.className = 'assoc-badge assoc-in';
      inBadge.textContent = '🔗';
      inBadge.title = `被 ${assocInCount} 个其他项目关联`;
      nameCell.appendChild(inBadge);
    }
    // Outgoing links count: this item associates to others
    if (assocCount > 0) {
      el.classList.add('has-assoc');
      const badge = document.createElement('span');
      badge.className = 'assoc-badge assoc-out';
      badge.textContent = '🔗' + assocCount;
      badge.title = `关联了 ${assocCount} 个项目`;
      nameCell.appendChild(badge);
    }
    if (state.selected.has(it.path)) el.classList.add('selected');
    if (state.cutItems.has(it.path)) el.classList.add('cut');
    return el;
  }

  // ---------- 视图控件同步 ----------
  function applyViewUI() {
    const v = state.view;
    const grid = $('file-grid');
    grid.classList.toggle('view-list', v.mode === 'list');
    grid.style.setProperty('--ic-size', v.iconSize + 'px');
    $('list-header').style.display = v.mode === 'list' ? '' : 'none';
    $('view-grid').classList.toggle('active', v.mode === 'grid');
    $('view-list').classList.toggle('active', v.mode === 'list');
    $('sort-key').value = v.sortKey;
    const dirBtn = $('sort-dir');
    dirBtn.textContent = v.sortDir === 'asc' ? '↑' : '↓';
    // 列表表头当前排序列高亮 + 方向箭头
    document.querySelectorAll('.lh-col').forEach(btn => {
      const on = btn.dataset.sort === v.sortKey;
      btn.classList.toggle('sort-on', on);
      btn.classList.toggle('sort-asc', on && v.sortDir === 'asc');
      btn.classList.toggle('sort-desc', on && v.sortDir === 'desc');
    });
    $('zoom-out').disabled = v.iconSize <= ICON_MIN;
    $('zoom-in').disabled = v.iconSize >= ICON_MAX;
  }

  function setViewMode(mode) {
    if (state.view.mode === mode) return;
    state.view.mode = mode;
    saveViewPref();
    applyViewUI();
  }

  function setSort(key, dir) {
    // 点击同一列（或同一选项）时切换升降序
    if (key === state.view.sortKey && dir === undefined) {
      state.view.sortDir = state.view.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      if (key) state.view.sortKey = key;
      if (dir) state.view.sortDir = dir;
    }
    saveViewPref();
    applyViewUI();
    renderCurrentItems();
  }

  function changeIconSize(delta) {
    const next = Math.min(ICON_MAX, Math.max(ICON_MIN, state.view.iconSize + delta));
    if (next === state.view.iconSize) return;
    state.view.iconSize = next;
    saveViewPref();
    applyViewUI();
  }

  // ---------- 列表视图列宽（表头拖动调整，记忆宽度）----------
  // 名称列默认弹性占满；手动拖过名称列后变为固定宽，超出视口时整行横向滚动，
  // 从而能像资源管理器一样看全长文件名。date/type/size 为固定宽列。
  const COLW_KEY = 'flm-colw-v1';
  const COLW_DEFAULT = { name: null, date: 142, type: 120, size: 86 };
  const COL_MIN = 60;
  const COL_MAX = 1200;
  let colW = { ...COLW_DEFAULT };
  // 拖拽列宽松手后的那一次标题 click 需要被吞掉，避免误触发排序
  let suppressHeaderSortClick = false;

  function loadColumnWidths() {
    try {
      const raw = JSON.parse(localStorage.getItem(COLW_KEY));
      if (raw && typeof raw === 'object') {
        colW = {
          name: typeof raw.name === 'number' ? raw.name : null,
          date: typeof raw.date === 'number' ? raw.date : COLW_DEFAULT.date,
          type: typeof raw.type === 'number' ? raw.type : COLW_DEFAULT.type,
          size: typeof raw.size === 'number' ? raw.size : COLW_DEFAULT.size
        };
      }
    } catch { /* 用默认值 */ }
  }
  function saveColumnWidths() {
    try { localStorage.setItem(COLW_KEY, JSON.stringify(colW)); } catch { /* 忽略 */ }
  }
  function applyColumnWidths() {
    const wrap = document.querySelector('.grid-wrap');
    if (!wrap) return;
    wrap.style.setProperty('--cw-date', colW.date + 'px');
    wrap.style.setProperty('--cw-type', colW.type + 'px');
    wrap.style.setProperty('--cw-size', colW.size + 'px');
    if (colW.name) wrap.style.setProperty('--cw-name', colW.name + 'px');
    else wrap.style.removeProperty('--cw-name');
    // 28(图标) + 四列宽 + 4 个 gap(8px) + 行内边距(20) + 外边距/余量(12)
    const nameW = colW.name || 120;
    wrap.style.setProperty('--list-min-w',
      (28 + nameW + colW.date + colW.type + colW.size + 32 + 20 + 12) + 'px');
  }
  function wireColumnResizers() {
    document.querySelectorAll('.lh-resizer').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation(); // 不触发标题按钮的排序
        const col = handle.dataset.col;                 // name | date | type
        const sortKey = col === 'date' ? 'mtime' : col; // 日期列按钮 data-sort=mtime
        const colBtn = document.querySelector(`.lh-col[data-sort="${sortKey}"]`);
        if (!colBtn) return;
        const startX = e.clientX;
        const startW = colBtn.getBoundingClientRect().width;
        document.body.classList.add('col-resizing');
        const onMove = (ev) => {
          const w = Math.max(COL_MIN, Math.min(COL_MAX, Math.round(startW + ev.clientX - startX)));
          if (col === 'name') colW.name = w;
          else colW[col] = w;
          applyColumnWidths();
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          document.body.classList.remove('col-resizing');
          saveColumnWidths();
          // click 紧接 mouseup 派发、早于下面的 setTimeout：吞掉这次“拖完补发”的标题点击
          suppressHeaderSortClick = true;
          setTimeout(() => { suppressHeaderSortClick = false; }, 0);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    });
  }

  // ---------- Selection ----------
  function selectItem(el, additive = false) {
    if (!additive) {
      document.querySelectorAll('.file-item.selected').forEach(e => e.classList.remove('selected'));
      state.selected.clear();
    } else if (el.classList.contains('selected')) {
      el.classList.remove('selected');
      state.selected.delete(el.dataset.path);
      updateToolbar();
      syncSelectionPanel();
      return;
    }
    el.classList.add('selected');
    state.selected.add(el.dataset.path);
    updateToolbar();
    syncSelectionPanel();
  }

  // 框选拖动过程中高频调用：只同步选中样式与集合，不触发关联面板加载
  function syncSelection(paths) {
    const next = new Set(paths);
    document.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('selected', next.has(el.dataset.path));
    });
    state.selected = next;
    updateToolbar();
  }

  // 根据当前选择集刷新右侧关联面板（0 项：提示；1 项：关联列表；多项：批量关联入口）
  function syncSelectionPanel() {
    if (state.selected.size === 1) {
      const p = [...state.selected][0];
      const el = document.querySelector(`.file-item[data-path="${CSS.escape(p)}"]`);
      loadAssoc(p, el ? el.dataset.name : p.split(/[\\\/]/).pop());
      loadRelationGraph(p);
    } else if (state.selected.size > 1) {
      showMultiAssocHint(state.selected.size);
    } else {
      setAssocTarget(null);
    }
  }

  // 多选时右侧面板的批量关联入口
  function showMultiAssocHint(n) {
    state.assocTarget = null;
    state.selectedAssoc.clear();
    $('assoc-target').innerHTML = `
      <div class="multi-hint">
        <div class="mh-ic">🔗</div>
        <div class="mh-count">已选择 <b>${n}</b> 个项目</div>
        <div class="mh-desc">可以把它们一次性关联到同一个文件或文件夹，之后从任一端都能快速跳到对方。</div>
        <button class="tool-btn primary mh-btn" id="btn-assoc-multi" type="button">🔗 将所选 ${n} 项关联到…</button>
      </div>`;
    $('assoc-reverse').style.display = 'none';
    $('btn-assoc-add').disabled = true;
    $('btn-assoc-open').disabled = true;
    $('btn-assoc-reveal').disabled = true;
    $('btn-assoc-remove').disabled = true;
    hideRelationGraph();
    $('btn-assoc-multi').onclick = associateSelectionTo;
  }

  // 将当前所有选中项批量关联到用户选择的同一个目标
  async function associateSelectionTo() {
    const sources = [...state.selected].filter(Boolean);
    if (sources.length < 1) return;
    const picked = await api.assoc.pick(state.currentDir || sources[0]);
    if (!picked || !picked.length) return;
    const target = picked[0]; // 批量关联只取第一个目标
    const tname = target.split(/[\\\/]/).pop();
    let ok = 0, fail = 0, self = 0;
    for (const src of sources) {
      if (src === target) { self++; continue; }
      try {
        const r = await api.assoc.add(src, target);
        if (r && r.ok) ok++; else fail++;
      } catch { fail++; }
    }
    if (ok > 0) {
      toast(`已将 ${ok} 个项目关联到「${tname}」` + (fail ? `，${fail} 个失败` : ''), fail ? 'error' : 'success');
    } else if (self > 0 && fail === 0) {
      toast('目标与所选项目是同一个，无需关联', 'error');
    } else {
      toast('关联失败，请重试', 'error');
    }
    await refresh();
    // refresh（navigate）会清空选择集并重建列表；把仍存在的源项目重新选中，
    // 保持多选状态与批量关联入口，角标也已随刷新重建
    const kept = sources.filter(p =>
      document.querySelector(`.file-item[data-path="${CSS.escape(p)}"]`));
    if (kept.length) {
      syncSelection(kept);
      state.anchorPath = kept[kept.length - 1];
    }
    syncSelectionPanel();
  }

  function updateToolbar() {
    // 文件操作按钮已移入右键菜单；这里只维护底部状态文本
    const n = state.selected.size;
    const status = $('status-text');
    if (n === 0) status.textContent = state.currentDir;
    else if (n === 1) status.textContent = [...state.selected][0].split(/[\\\/]/).pop();
    else status.textContent = `已选择 ${n} 项`;
    // 「后退」依赖浏览历史：没有历史时变灰禁用，避免与「↑ 上级」混淆
    const btnBack = $('btn-back');
    if (btnBack) btnBack.disabled = state.history.length === 0;
  }

  // ---------- File operations ----------
  async function newFolder() {
    const r = await api.op.mkdir(state.currentDir);
    if (!r.ok) return toast('新建文件夹失败：' + r.error, 'error');
    await refresh();
    setTimeout(() => tryInlineRename(r.path), 60);
  }

  async function copySelected(mode = 'copy') {
    const items = [...state.selected];
    if (!items.length) return;
    await api.clip.set(items, mode);
    state.canPaste = true;
    state.cutItems = mode === 'cut' ? new Set(items) : new Set();
    document.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('cut', state.cutItems.has(el.dataset.path));
    });
    updateToolbar();
    toast(mode === 'cut' ? `已剪切 ${items.length} 项` : `已复制 ${items.length} 项`);
  }

  async function pasteFromClipboard() {
    const r = await api.op.paste(state.currentDir);
    if (!r.ok) return toast(r.error, 'error');
    const fail = r.results.filter(x => !x.ok);
    state.canPaste = false; // clipboard is consumed after paste
    const c = await api.clip.get();
    state.canPaste = !!(c.items && c.items.length);
    toast(fail.length ? `完成，${fail.length} 项失败` : `已粘贴 ${r.results.length} 项`, fail.length ? 'error' : 'success');
    await refresh();
  }

  async function deleteSelected() {
    const items = [...state.selected];
    if (!items.length) return;
    if (!confirm(`确认将 ${items.length} 项移入回收站？`)) return;
    // Safe recycle-bin first; permanent delete as fallback
    const r = await api.shell.trash(items);
    let ok = r.ok;
    if (!ok && r.errors && r.errors.length) {
      const failedPaths = r.errors.map(x => x.path);
      const r2 = await api.op.delete(failedPaths);
      ok = r2.some(x => x.ok);
    }
    toast(ok ? '已删除' : '删除失败', ok ? 'success' : 'error');
    await refresh();
  }

  async function renameSelected() {
    const p = [...state.selected][0];
    if (p) tryInlineRename(p);
  }

  // ---------- 拖拽移动 / 复制 ----------
  // drag = 本窗口发起的拖拽上下文（外部拖入时为 null）
  state.drag = null;
  let dropHintEl = null;   // 当前高亮的落点 DOM
  let dropHintDir = null;  // 落点目录
  let transferBusy = false;

  function isInternalDrag() { return !!(state.drag && state.drag.paths.length); }

  function dragHasFiles(e) {
    const dt = e.dataTransfer;
    return !!dt && Array.from(dt.types || []).includes('Files');
  }

  function clearDropHint() {
    if (dropHintEl) dropHintEl.classList.remove('drag-over');
    document.body.classList.remove('dragging-files');
    dropHintEl = null;
    dropHintDir = null;
  }

  // 内部拖拽可预判非法落点（自身、自身子目录、已在该目录）；外部拖入放行，交给主进程校验
  function canDropAt(destDir) {
    if (!destDir) return false;
    if (!isInternalDrag()) return true;
    const d = destDir.toLowerCase();
    const sep = api.path.sep;
    return state.drag.paths.every(p => {
      const s = p.toLowerCase();
      if (d === s) return false;
      if (d.startsWith(s + sep)) return false;
      if (api.path.dirname(p).toLowerCase() === d) return false;
      return true;
    });
  }

  function setDropHint(el, dir) {
    if (dropHintEl === el && dropHintDir === dir) return;
    clearDropHint();
    if (!el) return;
    el.classList.add('drag-over');
    document.body.classList.add('dragging-files');
    dropHintEl = el;
    dropHintDir = dir;
  }

  // 资源管理器规则：Ctrl 强制复制、Shift 强制移动；
  // 内部默认移动，外部拖入默认 auto（同盘移动/异盘复制）
  function resolveDropMode(e) {
    if (e.ctrlKey) return 'copy';
    if (e.shiftKey) return 'move';
    return isInternalDrag() ? 'move' : 'auto';
  }

  // 各落点容器共用：dragover 时计算目标、高亮、声明是否允许放下
  function zoneDragOver(e, resolve) {
    // 外部拖入（OS Files）或本程序发起的内部拖拽（含未升级的页内 text/plain）都接受
    if (!dragHasFiles(e) && !isInternalDrag()) return;
    const ctx = resolve(e);
    if (!ctx || !canDropAt(ctx.dir)) {
      clearDropHint();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = resolveDropMode(e) === 'copy' ? 'copy' : 'move';
    setDropHint(ctx.el, ctx.dir);
  }

  async function zoneDrop(e, ctx) {
    e.preventDefault();
    const dir = ctx && ctx.dir;
    clearDropHint();
    // dragover 在窗口级被统一取消，非法目标仍可能收到 drop：内部拖拽再校验一次
    if (!dir || (isInternalDrag() && !canDropAt(dir))) { state.drag = null; return; }
    const mode = resolveDropMode(e);
    // 源路径：内部拖拽直接用；外部拖入经 webUtils 解析真实磁盘路径
    let items;
    if (isInternalDrag()) {
      items = state.drag.paths;
    } else {
      items = [...(e.dataTransfer.files || [])]
        .map(f => { try { return api.dnd.pathForFile(f); } catch { return ''; } })
        .filter(Boolean);
    }
    state.drag = null;
    if (!dir || !items.length) return;
    await performTransfer(items, dir, mode);
  }

  async function performTransfer(items, dir, mode) {
    if (transferBusy) return;
    transferBusy = true;
    try {
      const r = await api.op.transfer(items, dir, mode);
      if (!r.ok) { toast('无法放入：' + (r.error || '未知错误'), 'error'); return; }
      const ok = r.results.filter(x => x.ok);
      const fail = r.results.filter(x => !x.ok);
      const destName = dir.split(/[\\\/]/).pop() || dir;
      if (!ok.length) {
        const msg = fail[0] && fail[0].error ? fail[0].error : '未知错误';
        toast(msg, 'error');
      } else {
        const copied = ok.filter(x => x.action === 'copy').length;
        const verb = copied === ok.length ? '复制' : '移动';
        toast(`已${verb} ${ok.length} 项到「${destName}」` + (fail.length ? `，${fail.length} 项跳过` : ''),
          fail.length ? 'error' : 'success');
      }
      await refresh();
    } catch (err) {
      toast('拖放失败：' + err.message, 'error');
    } finally {
      transferBusy = false;
    }
  }

  function finishDrag() {
    clearDropHint();
    document.querySelectorAll('.file-item.drag-src').forEach(el => el.classList.remove('drag-src'));
    state.drag = null;
  }

  function tryInlineRename(targetPath) {
    const el = document.querySelector(`.file-item[data-path="${CSS.escape(targetPath)}"]`);
    if (!el) return;
    const nameEl = el.querySelector('.name');
    const oldName = el.dataset.name;
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.value = oldName;
    nameEl.replaceWith(input);
    input.focus();
    if (el.dataset.isdir !== '1') {
      const dot = oldName.lastIndexOf('.');
      if (dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    } else {
      input.select();
    }
    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (!newName || newName === oldName) {
        await refresh();
        return;
      }
      const r = await api.op.rename(targetPath, newName);
      if (!r.ok) toast('重命名失败：' + r.error, 'error');
      await refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { committed = true; refresh(); }
    });
    input.addEventListener('blur', commit);
  }

  async function revealSelected() {
    const p = [...state.selected][0];
    if (p) await api.shell.reveal(p);
  }

  async function openSelected() {
    const paths = [...state.selected];
    if (!paths.length) return;
    if (paths.length === 1) {
      // 单项：文件夹在本程序内进入，文件用默认程序打开
      const p = paths[0];
      const el = document.querySelector(`.file-item[data-path="${CSS.escape(p)}"]`);
      if (el && el.dataset.isdir === '1') { await navigate(p); return; }
      await api.shell.open(p);
      return;
    }
    // 多项：全部交给系统默认方式打开
    for (const p of paths) await api.shell.open(p);
  }

  // 打开方式…（仅单个文件）：弹出 Windows 系统“选择打开方式”对话框
  async function openAsSelected() {
    if (state.selected.size !== 1) return;
    const p = [...state.selected][0];
    const r = await api.shell.openAs(p);
    if (r && r.ok === false) toast('无法打开“打开方式”对话框：' + r.error, 'error');
  }

  // ---------- Association panel ----------
  async function loadAssoc(filePath, name) {
    state.assocTarget = filePath;
    state.selectedAssoc.clear();
    // 立即激活操作按钮，不等 IPC 返回（避免首次启动时按钮“慢一拍”）
    $('btn-assoc-add').disabled = false;
    updateAssocButtons();
    const target = $('assoc-target');
    target.innerHTML = `
      <div class="sb-title">关联列表（文件或文件夹）</div>
      <ul class="assoc-list" id="assoc-list"></ul>
    `;
    const list = await api.assoc.list(filePath);
    // 用户已切换选择后丢弃过期结果
    if (state.assocTarget !== filePath) return;
    renderAssocList(list);

    const refs = await api.assoc.search(filePath);
    if (state.assocTarget !== filePath) return;
    const rev = $('assoc-reverse');
    if (refs.length) {
      rev.style.display = '';
      rev.querySelector('#reverse-list').innerHTML = refs.map(p => {
        const n = p.split(/[\\\/]/).pop();
        return `<li data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(n)}</li>`;
      }).join('');
      rev.querySelectorAll('#reverse-list li').forEach(li => {
        li.onclick = () => {
          const dir = li.dataset.path.split(/[\\\/]/).slice(0, -1).join('\\');
          navigate(dir).then(() => {
            setTimeout(() => {
              const el = document.querySelector(`.file-item[data-path="${CSS.escape(li.dataset.path)}"]`);
              if (el) selectItem(el);
            }, 100);
          });
        };
      });
    } else {
      rev.style.display = 'none';
    }

    updateAssocButtons();
  }

  function setAssocTarget() {
    state.assocTarget = null;
    state.selectedAssoc.clear();
    $('assoc-target').innerHTML = '<div class="empty-hint">从左侧列表中选择一个文件或文件夹，即可查看或管理其关联项目。</div>';
    $('assoc-reverse').style.display = 'none';
    $('btn-assoc-add').disabled = true;
    $('btn-assoc-open').disabled = true;
    $('btn-assoc-reveal').disabled = true;
    $('btn-assoc-remove').disabled = true;
    hideRelationGraph();
  }

  function assocIconForName(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'ico'].includes(ext)) return IMG_SVG;
    if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return '🎬';
    if (['mp3', 'wav', 'flac'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📕';
    if (['doc', 'docx'].includes(ext)) return '📘';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
    if (['ppt', 'pptx'].includes(ext)) return '📙';
    if (['zip', '7z', 'rar'].includes(ext)) return '🗜';
    if (['exe', 'msi', 'bat', 'cmd', 'ps1'].includes(ext)) return '⚙';
    if (['txt', 'log'].includes(ext)) return '📄';
    return '📃';
  }

  function renderAssocList(list) {
    const ul = $('assoc-list');
    if (!ul) return;
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="assoc-empty">暂无关联项目，点击下方「添加关联…」</li>';
      return;
    }
    for (const p of list) {
      const name = p.split(/[\\\/]/).pop();
      const li = document.createElement('li');
      li.className = 'assoc-item';
      li.dataset.path = p;
      li.dataset.isdir = '0';
      li.innerHTML = `
        <span class="ic">${assocIconForName(name)}</span>
        <div class="info">
          <div class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="path" title="${escapeHtml(p)}">${escapeHtml(p)}</div>
        </div>
      `;
      // Detect type & existence in one stat call: folder icon, or strike-through if missing
      api.stat.file(p).then(st => {
        if (!st || !st.ok) {
          li.classList.add('missing');
        } else if (st.isDir) {
          li.dataset.isdir = '1';
          const ic = li.querySelector('.ic');
          if (ic) ic.textContent = '📁';
        }
      }).catch(() => li.classList.add('missing'));
      ul.appendChild(li);
    }
  }

  function updateAssocButtons() {
    const n = state.selectedAssoc.size;
    $('btn-assoc-open').disabled = n === 0;
    $('btn-assoc-reveal').disabled = n === 0;
    const btnRemove = $('btn-assoc-remove');
    btnRemove.disabled = n === 0;
    // 多选时在按钮上显示数量，提示可批量取消
    btnRemove.textContent = n > 1 ? `− 取消所选关联（${n}）` : '− 取消关联';
  }

  async function addAssoc() {
    if (!state.assocTarget) return;
    const target = state.assocTarget;
    const picked = await api.assoc.pick(target);
    if (!picked || !picked.length) return;
    // Don't associate an item with itself
    const valid = picked.filter(p => p !== target);
    if (!valid.length) { toast('不能将项目与自身关联', 'error'); return; }
    for (const p of valid) await api.assoc.add(target, p);
    toast(`已添加 ${valid.length} 个关联项目`, 'success');
    await refresh();
    restoreSelectionAfterRefresh(target);
  }

  async function removeAssoc() {
    const target = state.assocTarget;
    const toRemove = [...state.selectedAssoc];
    if (!target || !toRemove.length) return;
    // 一次 IPC 批量移除，避免逐条往返
    await api.assoc.removeMany(target, toRemove);
    state.selectedAssoc.clear();
    await refresh();
    // navigate 会清空选择并重渲染列表；这里稳定地把源文件重新选中并刷新其关联面板，
    // 避免取消关联后“什么都没选中”、还要再点一次原文件
    restoreSelectionAfterRefresh(target);
  }

  // refresh()/navigate() 之后恢复对指定源文件的单选，并重新加载其关联面板
  function restoreSelectionAfterRefresh(target) {
    if (!target) return;
    const el = document.querySelector(`.file-item[data-path="${CSS.escape(target)}"]`);
    if (!el) return;
    state.anchorPath = target;
    syncSelection([target]);
    syncSelectionPanel();
  }

  async function openAssoc() {
    const li = document.querySelector('.assoc-item.selected');
    const p = li ? li.dataset.path : [...state.selectedAssoc][0];
    if (!p) return;
    // Related folder -> navigate inside the app; related file -> open with default app
    if (li && li.dataset.isdir === '1') {
      await navigate(p);
    } else {
      // stat may not have resolved yet; fall back to shell.open (Explorer handles folders)
      await api.shell.open(p);
    }
  }

  async function revealAssoc() {
    const p = [...state.selectedAssoc][0];
    if (p) await api.shell.reveal(p);
  }

  // ---------- 左下角常驻关联图谱 ----------
  const GRAPH_W = 580;
  const GRAPH_H = 408;
  const MAX_CHAIN_LINES = 14;
  let graphReqId = 0; // 防止切换选择后旧响应覆盖新面板

  async function loadRelationGraph(centerPath) {
    const reqId = ++graphReqId;
    try {
      const g = await api.assoc.graph(centerPath);
      if (reqId !== graphReqId) return; // 已有更新的选择
      if (!g || !g.ok) return;
      state.graph.data = g;
      renderGraphPanel();
    } catch { /* 面板为辅助功能，失败静默 */ }
  }

  function hideRelationGraph() {
    graphReqId++;
    state.graph.data = null;
    renderGraphPanel();
  }

  // 放大/缩小按钮图标（双箭头）：放大=箭头背离朝四角，缩小=箭头相对朝中心
  // 注：Unicode ⤡/⤢ 两个字符的箭头都是朝外的，无法表达“朝内”，故用 SVG 绘制
  const ICON_EXPAND = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 L13 3 M9.5 3.5 L13 3 L12.5 6.5"/><path d="M7 9 L3 13 M3.5 9.5 L3 13 L6.5 12.5"/></svg>';
  const ICON_COLLAPSE = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 L9 7 M12.5 6.5 L9 7 L9.5 3.5"/><path d="M3 13 L7 9 M3.5 9.5 L7 9 L6.5 12.5"/></svg>';

  function renderGraphPanel() {
    const panel = $('rel-panel');
    const g = state.graph.data;
    const large = state.graph.large;
    panel.classList.toggle('mode-graph', large);
    panel.classList.toggle('mode-chain', !large);

    // 放大/缩小按钮
    const sizeBtn = $('rp-size');
    sizeBtn.innerHTML = large ? ICON_COLLAPSE : ICON_EXPAND;
    sizeBtn.title = large ? '收起' : '放大';

    const c = $('rp-content');
    c.innerHTML = '';

    const related = g ? g.nodes.length - 1 : 0;
    $('rp-count').textContent = related > 0 ? String(related) : '';

    if (!g) {
      // 常驻空态：未选择任何项目
      const empty = document.createElement('div');
      empty.className = 'rp-empty';
      empty.textContent = '选中文件或文件夹，查看它的关联关系';
      c.appendChild(empty);
      return;
    }
    if (g.nodes.length <= 1) {
      // 选中项无任何关联
      const empty = document.createElement('div');
      empty.className = 'rp-empty';
      const name = g.nodes[0] ? g.nodes[0].name : (g.center.split(/[\\\/]/).pop() || g.center);
      empty.innerHTML = `当前项目「${escapeHtml(name)}」暂无关联<br><span class="rp-empty-sub">可在右侧面板点「添加关联…」</span>`;
      c.appendChild(empty);
      return;
    }
    if (large) renderGraphView(g, c);
    else renderChainView(g, c);
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i).toLowerCase() : '';
  }

  function graphNodeEl(p, n, g) {
    const span = document.createElement('span');
    const isCenter = p === g.center;
    span.className = 'rp-node-name' + (isCenter ? ' center' : ' clickable') + (n && n.missing ? ' missing' : '');
    span.textContent = n ? n.name : p.split(/[\\\/]/).pop();
    span.title = n && !n.missing ? p + '（双击定位）' : p;
    if (!isCenter && n) span.onclick = () => loadRelationGraph(p);
    if (n) span.ondblclick = () => goToGraphNode(n);
    return span;
  }

  // Compact view: filenames strung together with arrows
  function buildChainLines(g) {
    const C = g.center;
    const out1 = g.edges.filter(e => e.from === C).map(e => e.to);
    const in1 = g.edges.filter(e => e.to === C && e.from !== C).map(e => e.from);
    const lines = [];
    const used = new Set();
    const k = (a, b) => a + '>' + b;
    for (const t of out1) {
      lines.push([{ p: C }, { p: t }]);
      used.add(k(C, t));
      for (const e of g.edges) {
        if (e.from === t && e.to !== C) {
          lines.push([{ p: C }, { p: t }, { p: e.to }]);
          used.add(k(t, e.to));
        }
      }
    }
    for (const s of in1) {
      lines.push([{ p: s }, { p: C }]);
      used.add(k(s, C));
      for (const e of g.edges) {
        if (e.to === s && e.from !== C) {
          lines.push([{ p: e.from }, { p: s }, { p: C }]);
          used.add(k(e.from, s));
        }
      }
    }
    // Remaining edges (depth1<->depth1 etc.) shown as plain pairs
    for (const e of g.edges) {
      if (!used.has(k(e.from, e.to))) lines.push([{ p: e.from }, { p: e.to }]);
    }
    return lines;
  }

  function renderChainView(g, container) {
    const hint = document.createElement('div');
    hint.className = 'rp-chain-hint';
    hint.textContent = '双击名字可定位到对应文件夹或文件（单击名字切换中心）';
    container.appendChild(hint);
    const lines = buildChainLines(g);
    const shown = lines.slice(0, MAX_CHAIN_LINES);
    for (const parts of shown) {
      const row = document.createElement('div');
      row.className = 'rp-chain-line';
      parts.forEach((part, i) => {
        if (i > 0) {
          const ar = document.createElement('span');
          ar.className = 'rp-arrow';
          ar.textContent = '→';
          row.appendChild(ar);
        }
        const n = g.nodes.find(x => x.path === part.p);
        row.appendChild(graphNodeEl(part.p, n, g));
      });
      container.appendChild(row);
    }
    if (lines.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'rp-chain-more';
      more.textContent = `还有 ${lines.length - shown.length} 条连接，点 ⤢ 放大查看全部`;
      container.appendChild(more);
    }
  }

  // Expanded view: radial node-link graph with directed arrows (2-hop rings)
  function layoutGraph(g) {
    const cx = GRAPH_W / 2;
    const cy = GRAPH_H / 2 - 4;
    const R1 = 106;
    const R2 = 182;
    const pos = new Map();
    pos.set(g.center, { x: cx, y: cy });

    const ring1 = g.nodes.filter(n => n.depth === 1);
    const N = ring1.length;
    const angle1 = i => -Math.PI / 2 + (N === 1 ? 0.35 : i * 2 * Math.PI / N);
    ring1.forEach((n, i) => {
      const a = angle1(i);
      pos.set(n.path, { x: cx + R1 * Math.cos(a), y: cy + R1 * Math.sin(a) });
    });

    // Group depth-2 nodes under their depth-1 parent
    const groups = new Map();
    const orphans = [];
    for (const n of g.nodes.filter(x => x.depth === 2)) {
      let par = n.parent;
      if (!par || !pos.has(par)) {
        const link = g.edges.find(e =>
          (e.from === n.path && ring1.some(d => d.path === e.to)) ||
          (e.to === n.path && ring1.some(d => d.path === e.from))
        );
        par = link ? (ring1.some(d => d.path === link.to) ? link.to : link.from) : null;
      }
      if (par && pos.has(par)) {
        if (!groups.has(par)) groups.set(par, []);
        groups.get(par).push(n);
      } else {
        orphans.push(n);
      }
    }
    const STEP = 0.42; // angular spacing between siblings (rad)
    ring1.forEach((n, i) => {
      const kids = groups.get(n.path) || [];
      const base = angle1(i);
      kids.forEach((kid, j) => {
        const a = base + (j - (kids.length - 1) / 2) * STEP;
        pos.set(kid.path, { x: cx + R2 * Math.cos(a), y: cy + R2 * Math.sin(a) });
      });
    });
    orphans.forEach((n, j) => {
      const a = Math.PI / 2 + j * 0.55;
      pos.set(n.path, { x: cx + R2 * Math.cos(a), y: cy + R2 * Math.sin(a) });
    });
    return pos;
  }

  function edgePath(pa, pb) {
    // Shorten both ends so the arrow stops at the node border
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const RA = 26, RB = 27;
    const x1 = pa.x + ux * RA, y1 = pa.y + uy * RA;
    const x2 = pb.x - ux * RB, y2 = pb.y - uy * RB;
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  // 双击图谱节点：跳到该项目的上级文件夹并选中它（文件夹也不进入内部）
  async function goToGraphNode(n) {
    if (n.missing) { toast('该项目已不存在，无法定位', 'error'); return; }
    let dir = '';
    try { dir = await api.dir.parent(n.path); } catch { /* ignore */ }
    if (!dir || dir === n.path) { toast('已经是最顶层，无法定位', 'error'); return; }
    state.graph.large = false; // 导航后自动收起到侧栏底部
    await navigate(dir);
    setTimeout(() => {
      const el = document.querySelector(`.file-item[data-path="${CSS.escape(n.path)}"]`);
      if (el) selectItem(el);
    }, 120);
  }

  function renderGraphView(g, container) {
    const pos = layoutGraph(g);
    const svgNS = 'http://www.w3.org/2000/svg';

    // 可拖动的画布里层（SVG 连线层 + DOM 节点层一起平移）
    const canvas = document.createElement('div');
    canvas.className = 'rp-canvas';
    let panX = 0, panY = 0;
    const applyPan = () => { canvas.style.transform = `translate(${panX}px, ${panY}px)`; };

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'rp-svg');
    svg.setAttribute('viewBox', `0 0 ${GRAPH_W} ${GRAPH_H}`);
    const defs = document.createElementNS(svgNS, 'defs');
    defs.innerHTML = `
      <marker id="rp-arrow-out" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#2dd4bf"></path>
      </marker>
      <marker id="rp-arrow-in" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#4c8dff"></path>
      </marker>
      <marker id="rp-arrow-far" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#7a7a7a"></path>
      </marker>`;
    svg.appendChild(defs);

    for (const e of g.edges) {
      const pa = pos.get(e.from), pb = pos.get(e.to);
      if (!pa || !pb) continue;
      const line = document.createElementNS(svgNS, 'path');
      let cls = 'far', marker = 'rp-arrow-far';
      if (e.from === g.center) { cls = 'out'; marker = 'rp-arrow-out'; }
      else if (e.to === g.center) { cls = 'in'; marker = 'rp-arrow-in'; }
      line.setAttribute('class', 'rp-edge ' + cls);
      line.setAttribute('d', edgePath(pa, pb));
      line.setAttribute('marker-end', `url(#${marker})`);
      svg.appendChild(line);
    }
    canvas.appendChild(svg);

    const layer = document.createElement('div');
    layer.className = 'rp-nodes';
    for (const n of g.nodes) {
      const p = pos.get(n.path);
      if (!p) continue;
      const node = document.createElement('div');
      const depthCls = n.path === g.center ? 'center' : ('depth-' + n.depth);
      node.className = `rp-node ${depthCls}` + (n.missing ? ' missing' : '');
      node.style.left = p.x + 'px';
      node.style.top = p.y + 'px';
      node.title = n.path + (n.missing ? '（已不存在）' : '（双击定位）');
      const ic = iconFor({ isDir: n.isDir, ext: extOf(n.name) });
      node.innerHTML = `<div class="rp-ic">${ic.svg || ic.ch}</div><div class="rp-nlabel">${escapeHtml(n.name)}</div>`;
      node.ondblclick = () => goToGraphNode(n);
      layer.appendChild(node);
    }
    canvas.appendChild(layer);
    container.appendChild(canvas);

    // 拖动空白处平移画面（从节点上按下不触发）
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    container.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.rp-node')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = panX; oy = panY;
      canvas.classList.add('dragging');
      try { container.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针时忽略 */ }
    });
    container.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      // 软边界：内容可向四周多拉出一段，但不会被拖丢
      panX = Math.min(160, Math.max(container.clientWidth - GRAPH_W - 160, ox + dx));
      panY = Math.min(120, Math.max(container.clientHeight - GRAPH_H - 120, oy + dy));
      applyPan();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      canvas.classList.remove('dragging');
      try { container.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);

    const foot = document.createElement('div');
    foot.className = 'rp-graph-foot';
    foot.textContent = '青色：它关联出去 · 蓝色：被其他项目关联 · 双击节点定位到文件夹/文件 · 拖动画面查看';
    container.appendChild(foot);
  }

  // ---------- Sidebar ----------
  const DEFAULT_QUICK = () => [
    { name: '桌面', path: quickPaths.desktop },
    { name: '文档', path: quickPaths.documents },
    { name: '下载', path: quickPaths.downloads },
    { name: '图片', path: quickPaths.pictures },
    { name: '音乐', path: quickPaths.music },
    { name: '视频', path: quickPaths.videos },
    { name: '主目录', path: quickPaths.home }
  ];

  function renderQuick() {
    // 内置项过滤掉用户删除的，再拼接用户固定的文件夹；每项都可 × 移除
    const defaults = DEFAULT_QUICK().filter(d => !state.hiddenQuick.includes(d.path));
    const customs = state.customQuick.map(q => ({ name: q.name, path: q.path, custom: true }));
    const quicks = defaults.map(d => ({ ...d, custom: false })).concat(customs);
    const ul = $('quick-list');
    ul.innerHTML = quicks.map(q => `
      <li data-path="${escapeHtml(q.path)}" data-custom="${q.custom ? 1 : 0}" class="${state.currentDir === q.path ? 'active' : ''}" title="${escapeHtml(q.path)}">
        <span class="ic">${q.custom ? '📌' : '📂'}</span>
        <span class="lbl">${escapeHtml(q.name)}</span>
        <span class="quick-rm" title="${q.custom ? '从快速访问移除' : '隐藏（点 ↺ 可恢复）'}">×</span>
      </li>
    `).join('');
    ul.querySelectorAll('li').forEach(li => {
      li.querySelector('.quick-rm').onclick = (e) => {
        e.stopPropagation();
        if (li.dataset.custom === '1') removeQuick(li.dataset.path);
        else hideQuick(li.dataset.path);
      };
      li.onclick = () => navigate(li.dataset.path);
    });
    $('btn-quick-restore').style.display = state.hiddenQuick.length ? '' : 'none';
  }

  // Pick a folder and pin it to quick access
  async function addQuick() {
    const picked = await api.dir.pick();
    if (!picked) return;
    const r = await api.quick.add(picked);
    if (!r || !r.ok) { toast('添加失败：' + (r && r.error ? r.error : '未知错误'), 'error'); return; }
    state.customQuick = r.custom || [];
    state.hiddenQuick = r.hidden || [];
    renderQuick();
    toast('已固定到快速访问', 'success');
  }

  // 用户固定项：彻底删除
  async function removeQuick(p) {
    const r = await api.quick.remove(p);
    state.customQuick = (r && r.custom) || [];
    state.hiddenQuick = (r && r.hidden) || [];
    renderQuick();
    toast('已从快速访问移除');
  }

  // 内置项：隐藏（可通过 ↺ 恢复）
  async function hideQuick(p) {
    const r = await api.quick.hide(p);
    state.hiddenQuick = (r && r.hidden) || [];
    renderQuick();
    toast('已隐藏，可点 ↺ 恢复');
  }

  async function restoreQuick() {
    const r = await api.quick.restore();
    state.hiddenQuick = (r && r.hidden) || [];
    renderQuick();
    toast('已恢复默认快速访问项');
  }

  function refreshQuickActive() {
    document.querySelectorAll('#quick-list li').forEach(li => {
      li.classList.toggle('active', li.dataset.path === state.currentDir);
    });
  }

  async function refreshRecent() {
    const limit = state.settings ? state.settings.recentLimit : 8;
    const recent = (await api.recent.list()).slice(0, limit);
    const rul = $('recent-list');
    rul.innerHTML = recent.map(p => {
      const n = p.split(/[\\\/]/).pop() || p;
      return `<li data-path="${escapeHtml(p)}" title="${escapeHtml(p)}" class="${state.currentDir === p ? 'active' : ''}">
        <span class="ic">🕘</span><span>${escapeHtml(n)}</span>
      </li>`;
    }).join('');
    rul.querySelectorAll('li').forEach(li => li.onclick = () => navigate(li.dataset.path));
  }

  async function refreshDrives() {
    if (!state.drives) state.drives = await api.dir.drives();
    const dul = $('drives-list');
    dul.innerHTML = state.drives.map(d => `
      <li data-path="${escapeHtml(d)}" class="${state.currentDir === d ? 'active' : ''}">
        <span class="ic">💽</span><span>${d}</span>
      </li>
    `).join('');
    dul.querySelectorAll('li').forEach(li => li.onclick = () => navigate(li.dataset.path));
  }

  // ---------- 设置面板 ----------
  function applySettingsUI() {
    const s = state.settings;
    if (!s) return;
    // 侧栏“最近访问”区块显隐
    $('recent-section').style.display = s.recentEnabled ? '' : 'none';
  }

  function fillSettingsForm() {
    const s = state.settings;
    document.querySelectorAll('input[name="st-startup"]').forEach(r => { r.checked = r.value === s.startup; });
    $('st-custom-path').value = s.startupDir || '';
    $('st-recent-enabled').checked = !!s.recentEnabled;
    $('st-recent-limit').value = String(s.recentLimit);
    $('st-close-tray').checked = !!s.closeToTray;
    $('st-show-hidden').checked = !!s.showHidden;
    $('st-auto-start').checked = !!s.autoStart;
    $('st-remember-window').checked = s.rememberWindow !== false;
    $('st-show-badge').checked = s.showAssocBadge !== false;
  }

  // 设置面板左侧分类切换
  function switchSettingsTab(name) {
    document.querySelectorAll('#st-nav .st-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.settings-body .st-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  }

  function openSettings() {
    fillSettingsForm();
    switchSettingsTab('general');
    $('settings-overlay').classList.add('show');
  }
  function closeSettings() {
    $('settings-overlay').classList.remove('show');
  }

  async function patchSettings(patch, { after } = {}) {
    try {
      state.settings = await api.settings.set(patch);
      applySettingsUI();
      if (after) after();
    } catch (err) { toast('设置保存失败：' + err.message, 'error'); }
  }

  function wireSettings() {
    $('btn-settings').onclick = openSettings;
    $('st-close').onclick = closeSettings;
    $('settings-overlay').addEventListener('mousedown', (e) => {
      if (e.target === $('settings-overlay')) closeSettings();
    });

    document.querySelectorAll('input[name="st-startup"]').forEach(r => {
      r.onchange = () => { if (r.checked) patchSettings({ startup: r.value }); };
    });

    // 选择指定文件夹：复用自定义选择窗口（文件夹单选模式）
    $('st-custom-browse').onclick = async () => {
      const picked = await api.dir.pick();
      if (!picked) return;
      await patchSettings({ startup: 'custom', startupDir: picked });
      fillSettingsForm();
      toast('已设置启动文件夹', 'success');
    };

    $('st-recent-enabled').onchange = (e) => patchSettings({ recentEnabled: e.target.checked }, {
      after: () => { if (e.target.checked) refreshRecent().catch(() => {}); }
    });

    $('st-recent-limit').onchange = async (e) => {
      // 仅接受 0–10 的整数；非法或越界输入回退为当前值
      const n = Number(e.target.value);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        e.target.value = String(state.settings.recentLimit);
        toast('请输入 0–10 之间的整数', 'error');
        return;
      }
      await patchSettings({ recentLimit: n }, {
        after: () => refreshRecent().catch(() => {})
      });
    };

    $('st-recent-clear').onclick = async () => {
      await api.recent.clear();
      await refreshRecent();
      toast('最近访问记录已清空', 'success');
    };

    $('st-close-tray').onchange = (e) => patchSettings({ closeToTray: e.target.checked });
    $('st-show-hidden').onchange = (e) => patchSettings({ showHidden: e.target.checked }, {
      after: () => navigate(state.currentDir, false)
    });
    $('st-auto-start').onchange = (e) => patchSettings({ autoStart: e.target.checked });
    $('st-remember-window').onchange = (e) => patchSettings({ rememberWindow: e.target.checked });
    $('st-show-badge').onchange = (e) => patchSettings({ showAssocBadge: e.target.checked }, {
      after: () => renderCurrentItems()
    });

    // 左侧分类导航
    document.querySelectorAll('#st-nav .st-nav-item').forEach(b => {
      b.onclick = () => switchSettingsTab(b.dataset.tab);
    });

    // 关于页：点击复制反馈邮箱
    $('st-mail-copy').onclick = async () => {
      const mail = $('st-mail').textContent.trim();
      const r = await api.sys.copyText(mail);
      const btn = $('st-mail-copy');
      if (r && r.ok) {
        btn.textContent = '已复制 ✓';
        btn.classList.add('copied');
        toast('反馈邮箱已复制到剪贴板', 'success');
        setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1600);
      } else {
        toast('复制失败，请手动选择邮箱复制', 'error');
      }
    };

    // ---------- 关联数据备份 / 恢复 ----------
    $('st-backup-export').onclick = async () => {
      const r = await api.backup.exportLinks();
      if (r && r.canceled) return;
      if (r && r.ok) {
        toast(`已备份 ${r.links} 条链接到：${r.path}`, 'success');
      } else {
        toast('备份失败：' + ((r && r.error) || '未知错误'), 'error');
      }
    };
    $('st-backup-merge').onclick = async () => {
      const r = await api.backup.importLinks('merge');
      if (r && r.canceled) return;
      if (r && r.ok) {
        toast(`恢复完成（合并）：新增 ${r.addedLinks} 条，当前共 ${r.links} 条链接`, 'success');
        await navigate(state.currentDir, false);
      } else {
        toast('恢复失败：' + ((r && r.error) || '未知错误'), 'error');
      }
    };
    $('st-backup-replace').onclick = async () => {
      const ok = window.confirm('覆盖恢复会先用备份内容替换当前全部关联链接，现有关联将被清除。\n\n建议先点“备份当前链接”留底。确定继续覆盖吗？');
      if (!ok) return;
      const r = await api.backup.importLinks('replace');
      if (r && r.canceled) return;
      if (r && r.ok) {
        toast(`覆盖恢复完成：当前共 ${r.links} 条链接`, 'success');
        await navigate(state.currentDir, false);
      } else {
        toast('恢复失败：' + ((r && r.error) || '未知错误'), 'error');
      }
    };
  }

  // ---------- Context menu ----------
  function closeContextMenu() {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  }

  // Global dismissal, registered ONCE. Capture phase so a right-click that
  // opens a new menu first closes the old one before the opening handler runs.
  // Previously per-menu {once:} listeners were registered via setTimeout and
  // a stale 'contextmenu' listener killed every newly opened menu, making the
  // right-click menu fail on its second use.
  function registerContextMenuDismissal() {
    document.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && !e.target.closest('.ctx-menu')) closeContextMenu();
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (e.target && e.target.closest && !e.target.closest('.ctx-menu')) closeContextMenu();
    }, true);
    window.addEventListener('blur', closeContextMenu);
  }

  // item = 右键命中的文件/文件夹元素；为 null 表示在空白区域右键
  function showContextMenu(x, y, item) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const multi = state.selected.size;
    const anySelected = multi > 0;
    const onItem = !!item;
    const singleFile = multi === 1 && item && item.dataset.isdir === '0';

    // 空白区域：粘贴 / 新建 / 刷新 / 全选
    if (!onItem) {
      buildMenu(menu, [
        { label: '粘贴', ic: '📋', hint: 'Ctrl+V', fn: pasteFromClipboard, disabled: !state.canPaste },
        { label: '新建文件夹', ic: '📁', hint: 'Ctrl+Shift+N', fn: newFolder },
        { sep: true },
        { label: '刷新', ic: '↻', hint: 'F5', fn: refresh },
        { label: '全选', ic: '⬚', hint: 'Ctrl+A', fn: selectAll, disabled: !state.lastItems.length }
      ]);
      appendMenu(menu, x, y);
      return;
    }

    // 项目上：打开类 / 复制剪切 / 重命名删除 / 新建 / 关联
    const items = [
      { label: multi > 1 ? `打开所选 ${multi} 项` : '打开', ic: '↗', hint: 'Enter', fn: openSelected, disabled: !anySelected },
      singleFile ? { label: '打开方式…', ic: '⚯', fn: openAsSelected } : null,
      { label: '在资源管理器中显示', ic: '📂', fn: revealSelected, disabled: !anySelected },
      { sep: true },
      { label: '剪切', ic: '✂', hint: 'Ctrl+X', fn: () => copySelected('cut'), disabled: !anySelected },
      { label: '复制', ic: '⧉', hint: 'Ctrl+C', fn: () => copySelected('copy'), disabled: !anySelected },
      { sep: true },
      { label: '重命名', ic: '✎', hint: 'F2', fn: renameSelected, disabled: multi !== 1 },
      { label: '删除（移入回收站）', ic: '🗑', hint: 'Delete', fn: deleteSelected, disabled: !anySelected },
      { sep: true },
      { label: '在此新建文件夹', ic: '📁', hint: 'Ctrl+Shift+N', fn: newFolder }
    ].filter(Boolean);
    if (multi === 1) {
      items.push({ sep: true });
      items.push({ label: '查看关联', ic: '🔗', fn: () => loadAssoc(item.dataset.path, item.dataset.name) });
      items.push({ label: '添加关联…', ic: '＋', fn: () => { selectItem(item); addAssoc(); } });
    } else if (multi >= 2) {
      items.push({ sep: true });
      items.push({ label: `将所选 ${multi} 项关联到…`, ic: '🔗', fn: associateSelectionTo });
    }
    buildMenu(menu, items);
    appendMenu(menu, x, y);
  }

  function buildMenu(menu, items) {
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'sep';
        menu.appendChild(s);
        continue;
      }
      const e = document.createElement('div');
      e.className = 'item' + (it.disabled ? ' disabled' : '');
      e.innerHTML = `<span class="ic-wrap">${it.ic}</span><span class="lbl">${it.label}</span>` +
        (it.hint ? `<span class="hint">${it.hint}</span>` : '');
      if (!it.disabled) e.onclick = () => { closeContextMenu(); it.fn(); };
      menu.appendChild(e);
    }
  }

  function appendMenu(menu, x, y) {
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
  }

  function selectAll() {
    document.querySelectorAll('.file-item').forEach(el => {
      el.classList.add('selected');
      state.selected.add(el.dataset.path);
    });
    updateToolbar();
    syncSelectionPanel();
  }

  // ---------- Event wiring ----------
  function wire() {
    registerContextMenuDismissal();
    $('btn-quick-add').onclick = addQuick;
    $('btn-quick-restore').onclick = restoreQuick;

    // 常驻关联图谱：放大 / 收起
    $('rp-size').onclick = () => { state.graph.large = !state.graph.large; renderGraphPanel(); };

    $('btn-back').onclick = goBack;
    $('btn-up').onclick = goUp;
    $('btn-refresh').onclick = refresh;
    $('addr').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = $('addr').value.trim();
        if (v) navigate(v);
      }
    });

    $('btn-assoc-add').onclick = addAssoc;
    $('btn-assoc-remove').onclick = removeAssoc;
    $('btn-assoc-open').onclick = openAssoc;
    $('btn-assoc-reveal').onclick = revealAssoc;

    const grid = $('file-grid');

    // ---- 鼠标拖框多选（marquee selection）----
    // 仅在左键真正发生拖动（超过阈值）时接管，普通点击仍交给 click 处理；
    // Ctrl 按住拖动 = 在原选择集上叠加，与资源管理器一致。
    let marqueePress = null;
    let suppressGridClick = false;
    const MARQUEE_THRESHOLD = 4;

    grid.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // 重命名输入框等特殊控件不参与框选
      if (e.target.closest('.rename-input, input, button, .ctx-menu')) return;
      if (e.shiftKey) return; // Shift 单击走区间连选
      // 按在文件项上：移动动作交给原生拖拽（dragstart），这里不启动拖框
      if (e.target.closest('.file-item')) return;
      // 按下瞬间快照所有项目的位置：拖动过程中即使状态栏文本变化等原因
      // 触发了页面回流，命中判定仍以按下时的布局为准，不会误选
      const rects = [...grid.querySelectorAll('.file-item')].map(el => {
        const r = el.getBoundingClientRect();
        return { el, l: r.left, t: r.top, r: r.right, b: r.bottom };
      });
      marqueePress = {
        x: e.clientX, y: e.clientY,
        started: false,
        base: new Set(state.selected),
        box: null,
        rects
      };
    });

    window.addEventListener('mousemove', (e) => {
      const p = marqueePress;
      if (!p) return;
      // 左键已松开（例如原生拖拽结束后系统不补发 mouseup）：解除框选武装，
      // 否则随后的普通鼠标移动可能凭空画出选框
      if (e.buttons === 0) { marqueePress = null; return; }
      if (!p.started) {
        if (Math.abs(e.clientX - p.x) < MARQUEE_THRESHOLD &&
            Math.abs(e.clientY - p.y) < MARQUEE_THRESHOLD) return;
        p.started = true;
        p.box = document.createElement('div');
        p.box.className = 'marquee';
        document.body.appendChild(p.box);
        document.body.classList.add('marqueeing');
      }
      const x1 = Math.min(e.clientX, p.x), y1 = Math.min(e.clientY, p.y);
      const x2 = Math.max(e.clientX, p.x), y2 = Math.max(e.clientY, p.y);
      p.box.style.left = x1 + 'px';
      p.box.style.top = y1 + 'px';
      p.box.style.width = (x2 - x1) + 'px';
      p.box.style.height = (y2 - y1) + 'px';

      // 与框选矩形相交的项目即为命中（几何取自按下时的快照）
      const hit = new Set();
      for (const rc of p.rects) {
        if (rc.l < x2 && rc.r > x1 && rc.t < y2 && rc.b > y1) {
          hit.add(rc.el.dataset.path);
        }
      }
      // Ctrl/⌘：在按下时的选择集基础上叠加；否则以框选结果替换
      if (e.ctrlKey || e.metaKey) {
        for (const v of p.base) hit.add(v);
      }
      syncSelection([...hit]);
    });

    window.addEventListener('mouseup', () => {
      const p = marqueePress;
      if (!p) return;
      marqueePress = null;
      if (p.started) {
        if (p.box) p.box.remove();
        document.body.classList.remove('marqueeing');
        suppressGridClick = true; // 拖动结束后的 click 不再触发单选/清空
        // 框选最后命中的末尾项作为下一次 Shift 连选锚点
        const picked = [...grid.querySelectorAll('.file-item')].filter(el => el.classList.contains('selected'));
        if (picked.length) state.anchorPath = picked[picked.length - 1].dataset.path;
        syncSelectionPanel();
      }
    });

    grid.addEventListener('click', (e) => {
      // 框选拖动结束后系统补发的 click：丢弃，避免把多选结果冲掉
      if (suppressGridClick) { suppressGridClick = false; return; }
      const item = e.target.closest('.file-item');
      if (!item) {
        document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
        state.selected.clear();
        state.anchorPath = null;
        updateToolbar();
        setAssocTarget(null);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        selectItem(item, true);
      } else if (e.shiftKey) {
        // 从锚点项到当前项做区间连选（替换式，与资源管理器一致）
        const all = [...grid.querySelectorAll('.file-item')];
        const b = all.indexOf(item);
        let a = state.anchorPath
          ? all.findIndex(x => x.dataset.path === state.anchorPath)
          : -1;
        if (a < 0) a = all.findIndex(x => x.classList.contains('selected'));
        if (a < 0 || b < 0) {
          selectItem(item);
          state.anchorPath = item.dataset.path;
        } else {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          syncSelection(all.slice(lo, hi + 1).map(el => el.dataset.path));
          syncSelectionPanel();
        }
      } else {
        selectItem(item);
        state.anchorPath = item.dataset.path;
      }
    });
    grid.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.file-item');
      if (!item) return;
      if (item.dataset.isdir === '1') navigate(item.dataset.path);
      else api.shell.open(item.dataset.path);
    });
    grid.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const item = e.target.closest('.file-item');
      if (item && !item.classList.contains('selected')) selectItem(item);
      showContextMenu(e.clientX, e.clientY, item);
    });

    // ---- 文件拖拽：拖到子文件夹 / 空白处(当前目录) / 侧栏 / 上级按钮 ----
    grid.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.file-item');
      if (!item || e.target.closest('.rename-input')) { e.preventDefault(); return; }
      // 拖未选中的项：只拖它一个并即时选中；拖已选中的项：拖整个选择集（多选移动）
      let paths;
      let singleIsDir = item.dataset.isdir === '1';
      if (state.selected.has(item.dataset.path)) {
        paths = [...state.selected];
      } else {
        document.querySelectorAll('.file-item.selected').forEach(x => x.classList.remove('selected'));
        state.selected.clear();
        item.classList.add('selected');
        state.selected.add(item.dataset.path);
        state.anchorPath = item.dataset.path;
        updateToolbar();
        paths = [item.dataset.path];
      }
      marqueePress = null; // 原生拖拽期间不产生 mousemove/mouseup，解除框选武装
      document.querySelectorAll('.file-item').forEach(el => {
        el.classList.toggle('drag-src', state.selected.has(el.dataset.path));
      });
      // 窗口内拖拽由 Blink 页内 HTML5 拖拽承担：拖到文件夹/侧栏/上级落点均可实时响应
      state.drag = { paths };
      e.dataTransfer.effectAllowed = 'copyMove';
      try { e.dataTransfer.setData('text/plain', paths.join('\n')); } catch { /* 忽略 */ }
    });
    document.addEventListener('dragend', finishDrag);

    // 文件区落点：文件夹项 → 进入该文件夹；空白/文件项 → 当前目录（外部拖入时有效）
    const gridTarget = (e) => {
      const folder = e.target.closest('.file-item[data-isdir="1"]');
      if (folder) return { el: folder, dir: folder.dataset.path };
      return { el: grid, dir: state.currentDir };
    };
    grid.addEventListener('dragover', (e) => zoneDragOver(e, gridTarget));
    grid.addEventListener('drop', (e) => zoneDrop(e, gridTarget(e)));

    // 侧栏：快速访问 / 最近访问 / 驱动器
    ['quick-list', 'recent-list', 'drives-list'].forEach(id => {
      const ul = $(id);
      const resolve = (e) => {
        const li = e.target.closest('li[data-path]');
        return li ? { el: li, dir: li.dataset.path } : null;
      };
      ul.addEventListener('dragover', (e) => zoneDragOver(e, resolve));
      ul.addEventListener('drop', (e) => {
        const li = e.target.closest('li[data-path]');
        if (li) zoneDrop(e, { el: li, dir: li.dataset.path });
      });
    });

    // 拖到“上级”按钮 = 移动到父目录
    const upBtn = $('btn-up');
    const upDir = () => {
      if (!state.currentDir) return '';
      const p = api.path.dirname(state.currentDir);
      return p === state.currentDir ? '' : p;
    };
    upBtn.addEventListener('dragover', (e) => zoneDragOver(e, () => ({ el: upBtn, dir: upDir() })));
    upBtn.addEventListener('drop', (e) => {
      const d = upDir();
      if (d) zoneDrop(e, { el: upBtn, dir: d });
    });

    // 窗口其余区域：阻止浏览器默认的“拖入即打开文件”，非法落点显示禁止光标
    window.addEventListener('dragover', (e) => {
      if (!dragHasFiles(e) && !isInternalDrag()) return;
      e.preventDefault();
      if (!dropHintDir) e.dataTransfer.dropEffect = 'none';
    });
    window.addEventListener('drop', (e) => {
      if (dragHasFiles(e) || isInternalDrag()) e.preventDefault();
    });
    // 拖出窗口外松开：无落点，拖拽结束时统一清理高亮
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) clearDropHint();
    });

    $('assoc-target').addEventListener('click', (e) => {
      const li = e.target.closest('.assoc-item');
      if (!li) return;
      if (e.ctrlKey) {
        li.classList.toggle('selected');
        if (li.classList.contains('selected')) state.selectedAssoc.add(li.dataset.path);
        else state.selectedAssoc.delete(li.dataset.path);
      } else {
        document.querySelectorAll('.assoc-item.selected').forEach(x => x.classList.remove('selected'));
        state.selectedAssoc.clear();
        li.classList.add('selected');
        state.selectedAssoc.add(li.dataset.path);
      }
      updateAssocButtons();
    });
    $('assoc-target').addEventListener('dblclick', (e) => {
      const li = e.target.closest('.assoc-item');
      if (!li) return;
      // Ensure it's the selected one, then open (folders navigate in-app)
      if (!li.classList.contains('selected')) {
        document.querySelectorAll('.assoc-item.selected').forEach(x => x.classList.remove('selected'));
        state.selectedAssoc.clear();
        li.classList.add('selected');
        state.selectedAssoc.add(li.dataset.path);
        updateAssocButtons();
      }
      openAssoc();
    });
    $('assoc-target').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const li = e.target.closest('.assoc-item');
      if (!li) return;
      if (!li.classList.contains('selected')) {
        document.querySelectorAll('.assoc-item.selected').forEach(x => x.classList.remove('selected'));
        state.selectedAssoc.clear();
        li.classList.add('selected');
        state.selectedAssoc.add(li.dataset.path);
        updateAssocButtons();
      }
      closeContextMenu();
      const menu = document.createElement('div');
      menu.className = 'ctx-menu';
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      const make = (label, ic, fn) => {
        const d = document.createElement('div');
        d.className = 'item';
        d.innerHTML = `<span class="ic-wrap">${ic}</span><span>${label}</span>`;
        d.onclick = () => { closeContextMenu(); fn(); };
        menu.appendChild(d);
      };
      make('打开关联项目', '↗', openAssoc);
      make('在资源管理器中定位', '📂', revealAssoc);
      const sep = document.createElement('div'); sep.className = 'sep'; menu.appendChild(sep);
      make('取消关联', '−', removeAssoc);
      document.body.appendChild(menu);
    });

    // Custom titlebar window controls
    $('win-min').onclick = () => api.win.minimize();
    $('win-max').onclick = () => api.win.maximize();
    $('win-close').onclick = () => api.win.close();
    wireSettings();

    // 视图：网格 / 列表切换
    $('view-grid').onclick = () => setViewMode('grid');
    $('view-list').onclick = () => setViewMode('list');
    // 排序：下拉选择 + 升降序按钮 + 列表表头点击
    $('sort-key').onchange = (e) => setSort(e.target.value);
    $('sort-dir').onclick = () => setSort(state.view.sortKey);
    document.querySelectorAll('.lh-col').forEach(btn => {
      btn.onclick = () => {
        // 拖动列宽手柄松手会补发一次 click，这里丢弃，避免误排序
        if (suppressHeaderSortClick) return;
        setSort(btn.dataset.sort);
      };
    });
    // 列表表头列宽拖拽
    loadColumnWidths();
    applyColumnWidths();
    wireColumnResizers();
    // 图标缩放：工具条按钮 + Ctrl+滚轮
    $('zoom-in').onclick = () => changeIconSize(ICON_STEP);
    $('zoom-out').onclick = () => changeIconSize(-ICON_STEP);
    document.querySelector('.grid-wrap').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      changeIconSize(e.deltaY < 0 ? ICON_STEP : -ICON_STEP);
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      // 输入框、重命名框、排序下拉框获得焦点时不拦截快捷键
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); goUp(); }
      else if (e.key === 'F5') { e.preventDefault(); refresh(); }
      else if (e.key === 'F2') { e.preventDefault(); renameSelected(); }
      else if (e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newFolder(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected('copy'); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'x') { e.preventDefault(); copySelected('cut'); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteFromClipboard(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
      else if (e.ctrlKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); changeIconSize(ICON_STEP); }
      else if (e.ctrlKey && e.key === '-') { e.preventDefault(); changeIconSize(-ICON_STEP); }
      else if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        state.view.iconSize = 44;
        saveViewPref();
        applyViewUI();
      }
      else if (e.key === 'Enter' && state.selected.size >= 1) { e.preventDefault(); openSelected(); }
      else if (e.key === 'Escape') {
        // 设置面板打开时优先关闭面板
        if ($('settings-overlay').classList.contains('show')) { closeSettings(); return; }
        closeContextMenu();
        document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
        state.selected.clear();
        state.anchorPath = null;
        updateToolbar();
        setAssocTarget(null);
      }
    });
  }

  // ---------- Init ----------
  (async function init() {
    wire();
    applyViewUI();
    renderGraphPanel();

    // 先拉设置：决定启动目录、最近访问显隐等
    try {
      state.settings = await api.settings.get();
    } catch { state.settings = null; }
    applySettingsUI();
    const verEl = $('st-version');
    if (verEl && state.settings && state.settings.version) verEl.textContent = 'v' + state.settings.version;

    renderQuick();
    api.quick.list().then(q => {
      if (q && Array.isArray(q.custom)) {
        state.customQuick = q.custom;
        state.hiddenQuick = q.hidden || [];
      } else if (Array.isArray(q)) {
        state.customQuick = q; // 兼容旧版数组响应
      }
      renderQuick();
    }).catch(() => {});
    refreshDrives().catch(() => {});
    if (!state.settings || state.settings.recentEnabled) refreshRecent().catch(() => {});
    try {
      const clip = await api.clip.get();
      state.canPaste = !!(clip.items && clip.items.length);
    } catch { /* ignore */ }

    // 启动目录：上次目录 / 主目录 / 指定文件夹；目标不可访问时回退主目录
    try {
      const s = state.settings;
      const home = await api.dir.home();
      let target = home;
      if (s && s.startup === 'custom' && s.startupDir) target = s.startupDir;
      else if (s && s.startup === 'last' && s.lastDir) target = s.lastDir;
      const probe = await api.dir.list(target);
      if (!probe.ok) target = home;
      await navigate(target, false);
    } catch (err) {
      hideLoading();
      toast('初始化失败：' + err.message, 'error');
    }
  })();
})();
