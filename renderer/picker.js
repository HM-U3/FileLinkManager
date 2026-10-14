// 关联目标选择器：文件/文件夹混合多选（可跨目录累积）
// 布局：左侧快速访问/最近/驱动器 + 中间文件网格（带关联角标） + 右侧已选区
(function () {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  const state = {
    currentDir: '',
    history: [],          // 后退栈
    items: [],            // 当前目录条目（显示顺序）
    assoc: {},            // path -> 出向关联数
    assocIn: {},          // path -> 入向关联数
    chosen: new Map(),    // 绝对路径 -> { name, isDir }，跨目录保留
    showBadge: true,      // 遵守主窗设置 showAssocBadge
    customQuick: [],      // 用户固定的快速访问
    hiddenQuick: [],      // 被隐藏的内置快速访问路径
    recent: [],
    drives: [],
    target: '',           // 正在为之添加关联的源文件/文件夹（仅 mode=both）
    focusPath: '',        // 右栏正在查看哪个“已选项”的关联（chosen 中的某个 B）
    focusAssoc: [],       // 该已选项 B 已有的关联 [{ path, name, isDir, missing }]
    flashPath: ''         // 跳转目录后需要高亮定位一次的路径
  };

  // 起始目录取自主进程传入的 query 参数；mode 决定选择对象
  // both = 文件/文件夹混合多选（添加关联）；dir = 仅文件夹单选（选目录）
  const qs = new URLSearchParams(location.search);
  const MODE = qs.get('mode') === 'dir' ? 'dir' : 'both';
  state.target = MODE === 'both' ? (qs.get('target') || '') : '';
  if (MODE === 'dir') document.title = '选择文件夹';
  document.body.classList.toggle('mode-dir', MODE === 'dir');

  function startDir() {
    try {
      return qs.get('dir') || '';
    } catch { return ''; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---------- 图标（与主窗保持同一套视觉语言） ----------
  const IMG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="3.6" width="18.8" height="16.8" rx="2.4"/><circle cx="8.6" cy="9" r="1.7" fill="currentColor" stroke="none"/><path d="M3.4 18.6 9 12.2l3 3.3 2.5-2.7 6.1 5.8"/></svg>';
  function iconFor(item) {
    if (item.isDir) return { cls: 'folder', ch: '📁' };
    const ext = item.ext;
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico'].includes(ext)) return { cls: 'img', ch: '', svg: IMG_SVG };
    if (['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm'].includes(ext)) return { ch: '🎬' };
    if (['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'].includes(ext)) return { ch: '🎵' };
    if (ext === '.pdf') return { ch: '📕' };
    if (['.doc', '.docx'].includes(ext)) return { ch: '📘' };
    if (['.xls', '.xlsx', '.csv'].includes(ext)) return { ch: '📗' };
    if (['.ppt', '.pptx'].includes(ext)) return { ch: '📙' };
    if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(ext)) return { ch: '🗜' };
    if (['.js', '.ts', '.json', '.py', '.go', '.c', '.cpp', '.java', '.rs', '.html', '.css', '.md'].includes(ext)) return { ch: '⌨' };
    if (['.exe', '.msi', '.bat', '.cmd', '.ps1'].includes(ext)) return { ch: '⚙' };
    if (['.txt', '.log'].includes(ext)) return { ch: '📄' };
    return { ch: '📃' };
  }

  // ---------- 导航 ----------
  let navToken = null; // 同一路径的并发导航（如快速双击）只执行一次
  async function navigate(dir, pushHistory = true) {
    if (!dir || navToken === dir) return;
    navToken = dir;
    let res;
    try {
      res = await api.dir.list(dir);
    } catch (err) {
      $('addr').value = state.currentDir;
      navToken = null;
      return;
    }
    if (!res || !res.ok) { $('addr').value = state.currentDir; navToken = null; return; }
    if (pushHistory && state.currentDir && state.currentDir !== res.path) {
      state.history.push(state.currentDir);
    }
    state.currentDir = res.path;
    state.items = res.items || [];
    state.assoc = res.assoc || {};
    state.assocIn = res.assocIn || {};
    $('addr').value = res.path;
    renderGrid();
    $('btn-back').disabled = state.history.length === 0;
    $('btn-up').disabled = false;
    syncSideActive();
    navToken = null;
  }

  async function goBack() {
    if (!state.history.length) return;
    await navigate(state.history.pop(), false);
  }
  async function goUp() {
    if (!state.currentDir) return;
    const parent = await api.dir.parent(state.currentDir);
    if (!parent || parent === state.currentDir) { $('btn-up').disabled = true; return; }
    await navigate(parent);
  }

  // ---------- 文件网格 + 关联角标 ----------
  function renderGrid() {
    const grid = $('file-grid');
    grid.innerHTML = '';
    const visible = MODE === 'dir' ? state.items.filter(it => it.isDir) : state.items;
    $('empty').style.display = visible.length ? 'none' : '';
    const frag = document.createDocumentFragment();
    for (const it of visible) {
      const el = document.createElement('div');
      el.className = 'file-item' + (state.chosen.has(it.path) ? ' selected' : '');
      el.dataset.path = it.path;
      el.dataset.name = it.name;
      el.dataset.isdir = it.isDir ? '1' : '0';
      const ic = iconFor(it);
      const cell = document.createElement('div');
      cell.className = 'name-cell';
      cell.innerHTML = `<div class="name" title="${escapeHtml(it.path)}">${escapeHtml(it.name)}</div>`;
      const outN = state.assoc[it.path] || 0;
      const inN = state.assocIn[it.path] || 0;
      // 入向：其他项目关联了它（蓝色 🔗）；出向：它关联了别的项目（青色 🔗N）
      if (state.showBadge && inN > 0) {
        const inBadge = document.createElement('span');
        inBadge.className = 'assoc-badge assoc-in';
        inBadge.textContent = '🔗';
        inBadge.title = `被 ${inN} 个其他项目关联`;
        cell.appendChild(inBadge);
      }
      if (state.showBadge && outN > 0) {
        const outBadge = document.createElement('span');
        outBadge.className = 'assoc-badge assoc-out';
        outBadge.textContent = '🔗' + outN;
        outBadge.title = `关联了 ${outN} 个项目`;
        cell.appendChild(outBadge);
      }
      // 文件夹左上角是“勾选本文件夹”的专用小框：未选时悬停显示 ＋，已选显示 ✓
      // 文件不显示这个标记（单击文件行即勾选）
      const tickHtml = it.isDir
        ? '<span class="tick"><span class="tick-plus">＋</span><span class="tick-check">✓</span></span>'
        : '<span class="tick">✓</span>';
      el.innerHTML = `
        ${tickHtml}
        <div class="ic ${ic.cls || ''}">${ic.svg ? `<span class="ic-svg">${ic.svg}</span>` : ic.ch}</div>
      `;
      el.appendChild(cell);
      frag.appendChild(el);
    }
    grid.appendChild(frag);

    // 跳转目录后，把目标项滚动到视野中并闪烁提示一次
    if (state.flashPath) {
      const fp = state.flashPath;
      state.flashPath = '';
      const hit = grid.querySelector(`.file-item[data-path="${CSS.escape(fp)}"]`);
      if (hit) {
        hit.scrollIntoView({ block: 'center' });
        hit.classList.add('flash');
        setTimeout(() => hit.classList.remove('flash'), 1500);
      }
    }
  }

  // ---------- 右侧已选区 ----------
  function renderChosen() {
    const wrap = $('sel-chips');
    wrap.innerHTML = '';
    for (const [p, info] of state.chosen) {
      const chip = document.createElement('span');
      chip.className = 'chip' + (p === state.focusPath ? ' focus' : '');
      chip.title = p + '\n（点击在下方查看它已有的关联）';
      chip.innerHTML = `<span class="chip-ic">${info.isDir ? '📁' : '📄'}</span><span class="chip-name">${escapeHtml(info.name)}</span><span class="chip-x" title="移除">✕</span>`;
      // 点 chip 主体 = 把它设为下方“关联预览”的查看对象（有已选项时始终保持一个聚焦）
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.chip-x')) return;
        if (state.focusPath !== p) setFocus(p);
      });
      chip.querySelector('.chip-x').onclick = (e) => {
        e.stopPropagation();
        state.chosen.delete(p);
        afterChosenChange();
      };
      wrap.appendChild(chip);
    }
    $('sel-count').textContent = state.chosen.size;
    $('btn-ok').disabled = state.chosen.size === 0;
    // 同步当前网格勾选态
    document.querySelectorAll('#file-grid .file-item').forEach(el => {
      el.classList.toggle('selected', state.chosen.has(el.dataset.path));
    });
  }

  // chosen 增删后的统一收口：保证 focus 始终指向一个有效的已选项，再刷新关联预览
  function afterChosenChange() {
    if (state.focusPath && !state.chosen.has(state.focusPath)) state.focusPath = '';
    if (!state.focusPath && state.chosen.size) {
      // 默认查看最近勾选的那一项（Map 保持插入顺序，取最后一个）
      state.focusPath = [...state.chosen.keys()].pop();
    }
    renderChosen();
    refreshFocusAssoc();
  }

  function setFocus(p) {
    state.focusPath = p;
    renderChosen();
    refreshFocusAssoc();
  }

  // ---------- 右栏：当前已选项 B 已有的关联 ----------
  let focusToken = 0; // 快速切换查看对象时丢弃过期的加载结果
  async function refreshFocusAssoc() {
    const token = ++focusToken;
    const ul = $('exist-list');
    const sub = $('exist-sub');
    const tip = $('exist-tip');
    const count = $('exist-count');
    ul.innerHTML = '';
    const focus = state.chosen.get(state.focusPath);

    if (!focus) {
      count.textContent = '0';
      tip.style.display = 'none';
      sub.textContent = '勾选中间的文件 / 文件夹后，这里会显示它已有的关联';
      sub.className = 'exist-sub muted';
      state.focusAssoc = [];
      return;
    }

    const n = state.chosen.size;
    sub.className = 'exist-sub';
    sub.innerHTML = `${focus.isDir ? '📁' : '📄'} 正在查看 <b>${escapeHtml(focus.name)}</b> 的关联`
      + (n > 1 ? ' <span class="exist-switch">（点上方其他已选项可切换）</span>' : '');
    tip.style.display = '';

    // 先用 chosen 里已知的信息占位，随后异步取真实关联
    count.textContent = '…';
    let paths = [];
    try {
      paths = await api.assoc.list(state.focusPath);
    } catch { paths = []; }
    if (token !== focusToken) return; // 用户已切到别的已选项
    // 并发查类型（stat 失败说明项目已被移动/删除，仍列出但灰显）
    const infos = await Promise.all(paths.map(async (p) => {
      let isDir = false;
      let missing = false;
      try {
        const st = await api.stat.file(p);
        if (st && st.ok) isDir = !!st.isDir;
        else missing = true;
      } catch { missing = true; }
      return { path: p, name: api.path.basename(p) || p, isDir, missing };
    }));
    if (token !== focusToken) return;
    state.focusAssoc = infos;
    renderFocusAssoc();
  }

  function renderFocusAssoc() {
    const ul = $('exist-list');
    ul.innerHTML = '';
    $('exist-count').textContent = state.focusAssoc.length;
    if (!state.focusAssoc.length) {
      const li = document.createElement('div');
      li.className = 'exist-empty';
      li.textContent = '它还没有任何关联～';
      ul.appendChild(li);
      return;
    }
    for (const it of state.focusAssoc) {
      const li = document.createElement('div');
      li.className = 'exist-item' + (it.missing ? ' missing' : '');
      li.dataset.path = it.path;
      li.title = it.missing ? it.path + '\n（可能已被移动或删除）' : it.path;
      li.innerHTML = `
        <span class="exist-ic">${it.isDir ? '📁' : '📄'}</span>
        <span class="exist-meta">
          <span class="exist-n">${escapeHtml(it.name)}</span>
          <span class="exist-dir">${escapeHtml(api.path.dirname(it.path) || '')}</span>
        </span>
        <span class="exist-picked" title="已在本次选择中">已选</span>
        <button class="exist-go" title="${it.isDir ? '打开这个文件夹' : '前往它所在的文件夹'}">前往</button>
      `;
      li.querySelector('.exist-go').onclick = (e) => {
        e.stopPropagation();
        gotoExist(it);
      };
      ul.appendChild(li);
    }
    syncExistChosenMarks();
  }

  // chosen 变化时，同步关联项上的“已选”小标记（已在本次选择中的项目无需重复选择）
  function syncExistChosenMarks() {
    document.querySelectorAll('.exist-item').forEach(li => {
      li.classList.toggle('picked', state.chosen.has(li.dataset.path));
    });
  }

  async function gotoExist(it) {
    let dir;
    if (it.isDir) {
      dir = it.path;          // 关联的是文件夹：直接进去
      state.flashPath = '';
    } else {
      dir = api.path.dirname(it.path);  // 关联的是文件：去它所在目录，并定位该文件
      state.flashPath = it.path;
    }
    await navigate(dir);
  }

  // ---------- 左侧栏 ----------
  function defaultQuick() {
    const qp = api.quickPaths || {};
    return [
      { name: '桌面', path: qp.desktop },
      { name: '文档', path: qp.documents },
      { name: '下载', path: qp.downloads },
      { name: '图片', path: qp.pictures },
      { name: '音乐', path: qp.music },
      { name: '视频', path: qp.videos },
      { name: '主目录', path: qp.home }
    ].filter(q => q.path);
  }

  function renderQuick() {
    // 内置项过滤掉用户隐藏的，再拼接用户固定项（与主窗逻辑一致）
    const defaults = defaultQuick().filter(d => !state.hiddenQuick.includes(d.path));
    const customs = state.customQuick.map(q => ({ name: q.name, path: q.path, custom: true }));
    const quicks = defaults.map(d => ({ ...d, custom: false })).concat(customs);
    const ul = $('quick-list');
    ul.innerHTML = quicks.map(q => `
      <li data-path="${escapeHtml(q.path)}" data-custom="${q.custom ? 1 : 0}" title="${escapeHtml(q.path)}">
        <span class="sic">${q.custom ? '📌' : '📂'}</span>
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
    syncSideActive();
  }

  async function addQuick() {
    // 复用单选文件夹选择器（以本窗口为父窗口的模态）
    const picked = await api.dir.pick();
    if (!picked) return;
    const r = await api.quick.add(picked);
    if (!r || !r.ok) return;
    state.customQuick = r.custom || [];
    state.hiddenQuick = r.hidden || [];
    renderQuick();
  }
  async function removeQuick(p) {
    const r = await api.quick.remove(p);
    state.customQuick = (r && r.custom) || [];
    state.hiddenQuick = (r && r.hidden) || [];
    renderQuick();
  }
  async function hideQuick(p) {
    const r = await api.quick.hide(p);
    state.hiddenQuick = (r && r.hidden) || [];
    renderQuick();
  }
  async function restoreQuick() {
    const r = await api.quick.restore();
    state.hiddenQuick = (r && r.hidden) || [];
    renderQuick();
  }

  function renderRecent(limit) {
    const list = state.recent.slice(0, limit);
    const ul = $('recent-list');
    ul.innerHTML = list.map(p => {
      const n = p.split(/[\\\/]/).pop() || p;
      return `<li data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">
        <span class="sic">🕘</span><span class="lbl">${escapeHtml(n)}</span>
      </li>`;
    }).join('');
    ul.querySelectorAll('li').forEach(li => li.onclick = () => navigate(li.dataset.path));
    syncSideActive();
  }

  function renderDrives() {
    const ul = $('drives-list');
    ul.innerHTML = state.drives.map(d => `
      <li data-path="${escapeHtml(d)}" title="${escapeHtml(d)}">
        <span class="sic">💽</span><span class="lbl">${escapeHtml(d)}</span>
      </li>
    `).join('');
    ul.querySelectorAll('li').forEach(li => li.onclick = () => navigate(li.dataset.path));
    syncSideActive();
  }

  // 当前目录变化时高亮左侧对应项
  function syncSideActive() {
    document.querySelectorAll('.side-left li').forEach(li => {
      li.classList.toggle('active', li.dataset.path === state.currentDir);
    });
  }

  // ---------- 选择交互 ----------
  function toggleChoose(item, { additive = false, range = false } = {}) {
    if (range) {
      const all = state.items;
      const anchor = all.findIndex(x => state.chosen.has(x.path));
      const idx = all.findIndex(x => x.path === item.path);
      if (anchor < 0 || idx < 0) { state.chosen.set(item.path, { name: item.name, isDir: item.isDir }); }
      else {
        const [lo, hi] = anchor < idx ? [anchor, idx] : [idx, anchor];
        for (let i = lo; i <= hi; i++) {
          state.chosen.set(all[i].path, { name: all[i].name, isDir: all[i].isDir });
        }
      }
    } else if (additive) {
      if (state.chosen.has(item.path)) state.chosen.delete(item.path);
      else state.chosen.set(item.path, { name: item.name, isDir: item.isDir });
    } else {
      // 单击已勾选项：保持不变；单击未勾选项：仅选它
      if (!state.chosen.has(item.path)) {
        // 仅清空“当前目录内”的选择，保留其他目录已累积项
        for (const it of state.items) state.chosen.delete(it.path);
        state.chosen.set(item.path, { name: item.name, isDir: item.isDir });
      }
    }
    afterChosenChange();
  }

  function pickCurrentDir() {
    if (!state.currentDir) return;
    const name = state.currentDir.split(/[\\/]/).filter(Boolean).pop() || state.currentDir;
    state.chosen.set(state.currentDir, { name, isDir: true });
    afterChosenChange();
  }

  function confirm() {
    if (MODE === 'dir') {
      if (state.currentDir) api.picker.confirm([state.currentDir]);
      return;
    }
    const paths = [...state.chosen.keys()];
    if (!paths.length) return;
    api.picker.confirm(paths);
  }
  function cancel() { api.picker.cancel(); }

  // ---------- 事件 ----------
  function wire() {
    $('btn-back').onclick = goBack;
    $('btn-up').onclick = goUp;
    $('btn-home').onclick = async () => { await navigate(await api.dir.home()); };
    $('btn-refresh').onclick = () => navigate(state.currentDir, false);
    $('addr').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = $('addr').value.trim(); if (v) navigate(v); }
    });

    const grid = $('file-grid');

    // ---- 鼠标拖框多选（marquee），仅“文件/文件夹混合勾选”模式启用 ----
    // 左键按下后真正拖过阈值才接管；普通点击仍交给 click（勾选 / 双击进入文件夹）。
    // 按住 Ctrl 拖动 = 在已勾选（含其他目录累积项）基础上叠加；
    // 不按 Ctrl = 用框选结果替换“当前目录”的勾选，但保留其他目录已勾选项。
    let marqueePress = null;
    let suppressGridClick = false;
    const MARQUEE_THRESHOLD = 4;

    grid.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || MODE !== 'both') return;
      if (e.target.closest('input, button')) return;
      if (e.shiftKey) return; // Shift 单击走区间连选
      const els = [...grid.querySelectorAll('.file-item')];
      const curPaths = new Set(els.map(el => el.dataset.path));
      const additive = e.ctrlKey || e.metaKey;
      // 按下瞬间快照布局：拖动过程中的命中判定以此为准，不受回流影响
      const rects = els.map(el => {
        const r = el.getBoundingClientRect();
        return { el, path: el.dataset.path, l: r.left, t: r.top, r: r.right, b: r.bottom };
      });
      marqueePress = {
        x: e.clientX, y: e.clientY,
        started: false,
        additive,
        base: new Set([...state.chosen.keys()].filter(p => additive || !curPaths.has(p))),
        box: null,
        rects
      };
    });

    window.addEventListener('mousemove', (e) => {
      const p = marqueePress;
      if (!p) return;
      // 左键已松开（系统可能不补发 mouseup）：解除武装，避免凭空画框
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
      // 与选框相交即命中；拖动过程中只更新网格高亮，不重建右侧已选区（保证流畅）
      const preview = new Set(p.base);
      for (const rc of p.rects) {
        if (rc.l < x2 && rc.r > x1 && rc.t < y2 && rc.b > y1) preview.add(rc.path);
      }
      for (const rc of p.rects) rc.el.classList.toggle('selected', preview.has(rc.path));
    });

    window.addEventListener('mouseup', () => {
      const p = marqueePress;
      if (!p) return;
      marqueePress = null;
      if (!p.started) return;
      if (p.box) p.box.remove();
      document.body.classList.remove('marqueeing');
      suppressGridClick = true; // 丢弃拖动结束后补发的 click，避免冲掉框选结果
      // 把最终框选结果提交到 chosen（跨目录累积）
      const curPaths = new Set(p.rects.map(rc => rc.path));
      if (!p.additive) for (const k of curPaths) state.chosen.delete(k);
      for (const rc of p.rects) {
        if (!rc.el.classList.contains('selected')) continue;
        const it = state.items.find(x => x.path === rc.path);
        if (it) state.chosen.set(rc.path, { name: it.name, isDir: it.isDir });
      }
      afterChosenChange();
    });

    grid.addEventListener('click', (e) => {
      // 框选拖动结束后系统补发的 click：丢弃
      if (suppressGridClick) { suppressGridClick = false; return; }
      const el = e.target.closest('.file-item');
      if (!el) return;
      const item = state.items.find(x => x.path === el.dataset.path);
      if (!item) return;
      // 文件夹单选模式：单击文件夹即进入（勾选交互只用于混合模式）
      if (MODE === 'dir') {
        if (item.isDir) navigate(item.path);
        return;
      }
      // ---- 混合模式的新操作逻辑 ----
      // 点文件夹左上角的“＋/✓”小框：只勾选该文件夹，不进入
      if (e.target.closest('.tick')) {
        toggleChoose(item, { additive: true });
        return;
      }
      if (item.isDir) {
        // 普通单击文件夹 = 进入；Ctrl / Shift 单击 = 勾选而不进入
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          toggleChoose(item, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
        } else {
          navigate(item.path);
        }
        return;
      }
      // 文件：单击勾选；Ctrl 增删、Shift 区间连选
      toggleChoose(item, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
    });
    // 双击：混合模式下双击文件直接确认（仅该文件）；文件夹单击即进入，这里仅作兜底
    grid.addEventListener('dblclick', (e) => {
      const el = e.target.closest('.file-item');
      if (!el) return;
      const item = state.items.find(x => x.path === el.dataset.path);
      if (!item) return;
      if (item.isDir) { navigate(item.path); return; }
      if (MODE === 'both') api.picker.confirm([item.path]);
    });

    $('btn-pick-dir').onclick = pickCurrentDir;
    $('btn-clear').onclick = () => { state.chosen.clear(); afterChosenChange(); };
    $('btn-ok').onclick = confirm;
    $('btn-cancel').onclick = cancel;
    $('btn-quick-add').onclick = addQuick;
    $('btn-quick-restore').onclick = restoreQuick;

    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT') return;
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); goUp(); }
    });
  }

  // ---------- 启动 ----------
  (async function init() {
    wire();
    if (MODE === 'dir') {
      // 文件夹单选：确定按钮始终可用（选择的是当前所在文件夹）
      $('btn-ok').textContent = '选择此文件夹';
      $('btn-ok').disabled = false;
    }

    // 并行加载左侧栏数据与设置（任何一项失败都不阻塞文件浏览）
    const start = startDir();
    const [home, quickRes, recentArr, drivesArr, settings] = await Promise.all([
      api.dir.home().catch(() => ''),
      api.quick.list().catch(() => null),
      api.recent.list().catch(() => []),
      api.dir.drives().catch(() => []),
      api.settings.get().catch(() => null)
    ]);

    if (quickRes) {
      state.customQuick = quickRes.custom || [];
      state.hiddenQuick = quickRes.hidden || [];
    }
    state.recent = recentArr || [];
    state.drives = drivesArr || [];
    if (settings) state.showBadge = settings.showAssocBadge !== false;

    renderQuick();
    renderDrives();
    // 最近访问遵守主窗开关与保留条数（选择器内只展示，不写入新记录）
    const recentEnabled = !settings || settings.recentEnabled !== false;
    $('recent-section').style.display = recentEnabled ? '' : 'none';
    if (recentEnabled) renderRecent(settings && typeof settings.recentLimit === 'number' ? settings.recentLimit : 8);

    // 右栏“已选项的关联”仅混合选择模式（添加关联）使用；文件夹单选模式隐藏
    if (MODE === 'dir') {
      $('exist-wrap').style.display = 'none';
    } else {
      refreshFocusAssoc();
    }

    await navigate(start || home);
  })();
})();
