const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen, clipboard: sysClipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const isDev = !app.isPackaged;

// Persisted path for the associations database and recent dirs
const dataDir = path.join(app.getPath('userData'), 'filelink');
const dbPath = path.join(dataDir, 'associations.json');
const recentPath = path.join(dataDir, 'recent.json');
const quickPath = path.join(dataDir, 'quick.json');
const settingsPath = path.join(dataDir, 'settings.json');

// 全局设置（白名单持久化；新增项只需在此补默认值）
const DEFAULT_SETTINGS = {
  startup: 'last',         // 启动时打开：last=上次目录 | home=用户主目录 | custom=指定文件夹
  startupDir: '',          // startup=custom 时的文件夹
  lastDir: '',             // 上次浏览的目录（startup=last 使用）
  recentEnabled: true,     // 是否记录并在侧栏显示“最近访问”
  recentLimit: 8,          // 最近访问保留条数（用户可设置 0–10 的整数）
  closeToTray: true,       // 点关闭按钮时隐藏到托盘；false=直接退出
  showHidden: true,        // 是否显示以 . 开头的隐藏项目
  autoStart: false,        // 开机（登录 Windows）后自动启动并驻留托盘
  rememberWindow: true,    // 记住主窗口大小与位置
  showAssocBadge: true     // 文件/文件夹名称旁显示关联数量标记
};
let settingsCache = null;
async function loadSettings() {
  if (settingsCache) return settingsCache;
  try {
    const j = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
    settingsCache = { ...DEFAULT_SETTINGS, ...(j && typeof j === 'object' ? j : {}) };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  // 旧版允许 15/30，新版限定 0–10：超界值加载时收敛到上限 10
  if (!Number.isInteger(settingsCache.recentLimit) || settingsCache.recentLimit < 0 || settingsCache.recentLimit > 10) {
    settingsCache.recentLimit = 10;
  }
  return settingsCache;
}
async function saveSettings(patch) {
  const cur = await loadSettings();
  settingsCache = { ...cur, ...patch };
  await fsp.writeFile(settingsPath, JSON.stringify(settingsCache, null, 2), 'utf8');
  return settingsCache;
}

// Clipboard for cross-process copy/cut operations (kept in memory only)
let clipboard = { items: [], mode: 'copy' };

// 单实例：再次启动时直接唤起已驻留后台的主窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

async function ensureDataDir() {
  await fsp.mkdir(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) await fsp.writeFile(dbPath, JSON.stringify({}, null, 2), 'utf8');
  if (!fs.existsSync(recentPath)) await fsp.writeFile(recentPath, JSON.stringify([], null, 2), 'utf8');
  if (!fs.existsSync(quickPath)) await fsp.writeFile(quickPath, JSON.stringify({ custom: [], hidden: [] }, null, 2), 'utf8');
  if (!fs.existsSync(settingsPath)) await fsp.writeFile(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
}

async function loadDb() {
  try {
    return JSON.parse(await fsp.readFile(dbPath, 'utf8'));
  } catch {
    return {};
  }
}

async function saveDb(db) {
  await fsp.writeFile(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

async function loadRecent() {
  try {
    return JSON.parse(await fsp.readFile(recentPath, 'utf8'));
  } catch {
    return [];
  }
}

async function saveRecent(arr, limit) {
  const max = Number.isFinite(limit) ? limit : ((await loadSettings()).recentLimit || 8);
  await fsp.writeFile(recentPath, JSON.stringify(arr.slice(0, max), null, 2), 'utf8');
}

// Quick-access state: { custom: [{ name, path }], hidden: [path, ...] }
// hidden 记录用户删除的内置项（桌面/文档等），可恢复；兼容旧版的纯数组格式。
async function loadQuick() {
  const empty = { custom: [], hidden: [] };
  try {
    const j = JSON.parse(await fsp.readFile(quickPath, 'utf8'));
    if (Array.isArray(j)) return { custom: j.filter(x => x && x.path), hidden: [] };
    return {
      custom: Array.isArray(j.custom) ? j.custom.filter(x => x && x.path) : [],
      hidden: Array.isArray(j.hidden) ? j.hidden.filter(x => typeof x === 'string') : []
    };
  } catch {
    return empty;
  }
}

async function saveQuick(q) {
  const data = { custom: (q.custom || []).slice(0, 30), hidden: q.hidden || [] };
  await fsp.writeFile(quickPath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

let tray = null;
let mainWindow = null;
let isQuiting = false;
let trayHintShown = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  // 优先高分图标，Windows 托盘会自动缩到 16px
  const iconFile = fs.existsSync(path.join(__dirname, 'assets', 'tray-icon-16.png'))
    ? 'tray-icon-16.png' : null;
  let img = nativeImage.createEmpty();
  if (iconFile) {
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile));
    if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon-32.png'));
  }
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('FileLinkManager —— 后台运行中');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 FileLinkManager', click: () => { isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

async function createWindow() {
  const s = await loadSettings();
  const winOpts = {
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'FileLinkManager',
    backgroundColor: '#0a0a0a',
    show: false, // shown on ready-to-show to avoid white flash
    // 'hidden' removes the OS title bar & caption buttons on Windows,
    // letting our custom HTML titlebar (in renderer/index.html) be the sole control.
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // 恢复上次窗口大小与位置（必须落在某个可用显示器工作区内，防止移出屏幕）
  if (s.rememberWindow && s.winBounds && typeof s.winBounds === 'object') {
    const b = s.winBounds;
    const valid = ['x', 'y', 'width', 'height'].every(k => Number.isFinite(b[k]));
    if (valid && b.width >= winOpts.minWidth && b.height >= winOpts.minHeight) {
      const onScreen = screen.getAllDisplays().some(d => {
        const wa = d.workArea;
        return b.x + b.width > wa.x && b.x < wa.x + wa.width &&
               b.y + b.height > wa.y && b.y < wa.y + wa.height;
      });
      if (onScreen) Object.assign(winOpts, { x: b.x, y: b.y, width: b.width, height: b.height });
    }
  }

  const win = new BrowserWindow(winOpts);
  mainWindow = win;

  // 拖动/缩放结束后防抖持久化窗口 bounds；最大化、最小化期间不记录
  let boundsTimer = null;
  const scheduleBoundsSave = () => {
    const cur = settingsCache;
    if (!cur || !cur.rememberWindow || win.isMaximized() || win.isMinimized()) return;
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isMaximized() && !win.isMinimized()) {
        saveSettings({ winBounds: win.getBounds() }).catch(() => {});
      }
    }, 500);
  };
  win.on('resize', scheduleBoundsSave);
  win.on('move', scheduleBoundsSave);

  win.once('ready-to-show', () => win.show());
  // 关闭按钮 = 隐藏到托盘；只有托盘菜单“退出”才真正结束
  win.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      win.hide();
      if (tray && !trayHintShown) {
        trayHintShown = true;
        tray.displayBalloon({
          iconType: 'info',
          title: 'FileLinkManager 仍在后台运行',
          content: '点击托盘图标可重新打开窗口；右键托盘图标选择“退出”才会完全关闭。'
        });
      }
    }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  await ensureDataDir();
  // 开机自启以系统注册表为准，与设置项同步一次
  try {
    const s = await loadSettings();
    app.setLoginItemSettings({ openAtLogin: !!s.autoStart, name: 'FileLinkManager' });
  } catch { /* 非 Windows 或无权限时忽略 */ }
  createTray();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Window controls (custom titlebar)
ipcMain.on('win:minimize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
});
ipcMain.on('win:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
});
ipcMain.on('win:close', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  // 设置为“直接退出”时彻底结束；否则走 win.on('close') 的隐藏到托盘逻辑
  const s = await loadSettings();
  if (s.closeToTray === false) {
    isQuiting = true;
    app.quit();
  } else {
    w.close();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ============================================================
// IPC: Directory listing
// ============================================================
ipcMain.handle('dir:list', async (event, dirPath) => {
  try {
    const target = dirPath || app.getPath('home');
    const settings = await loadSettings();
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      // Skip protected/hidden system items for clarity but keep .something
      if (e.name === 'System Volume Information' || e.name === '$RECYCLE.BIN') continue;
      // 用户关闭“显示隐藏项目”时，过滤以 . 开头的文件/文件夹
      if (!settings.showHidden && e.name.startsWith('.')) continue;
      try {
        const full = path.join(target, e.name);
        const stat = await fsp.stat(full);
        items.push({
          name: e.name,
          path: full,
          isDir: e.isDirectory(),
          size: stat.size,
          mtime: stat.mtimeMs,
          ext: e.isDirectory() ? '' : path.extname(e.name).toLowerCase()
        });
      } catch {
        // ignore stat errors (permission denied, locked files)
      }
    }
    // Directories first, then files; both alphabetical
    items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1));

    // Aggregate association counts in ONE db read (avoids per-file IPC storm).
    // Both files and folders can be association sources.
    // assoc     = outgoing links per item path (item -> others)
    // assocIn   = incoming references per item path (others -> item)
    const assoc = {};
    const assocIn = {};
    try {
      const db = await loadDb();
      const itemPaths = new Set(items.map(it => it.path));
      for (const [itemPath, list] of Object.entries(db)) {
        if (!Array.isArray(list) || !list.length) continue;
        if (itemPaths.has(itemPath)) assoc[itemPath] = list.length;
        for (const related of list) {
          if (itemPaths.has(related)) assocIn[related] = (assocIn[related] || 0) + 1;
        }
      }
    } catch { /* assoc info is optional */ }

    return { ok: true, path: target, items, assoc, assocIn };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dir:home', () => app.getPath('home'));
ipcMain.handle('dir:drives', async () => {
  // Windows: list drives by checking letters
  const drives = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c) + ':\\';
      try {
        await fsp.access(letter, fs.constants.R_OK);
        drives.push(letter);
      } catch {
        /* drive doesn't exist */
      }
    }
  }
  return drives;
});

ipcMain.handle('dir:pick', async (e) => {
  // 统一使用自定义选择窗口（文件夹单选模式），初始目录取上次浏览位置
  const s = await loadSettings();
  let startDir = s.lastDir || app.getPath('home');
  try { await fsp.access(startDir, fs.constants.R_OK); } catch { startDir = app.getPath('home'); }
  const parentWin = BrowserWindow.fromWebContents(e.sender);
  const paths = await openPicker(parentWin, { startDir, mode: 'dir', title: '选择文件夹' });
  return paths[0] || null;
});

ipcMain.handle('dir:parent', (e, p) => path.dirname(p));

ipcMain.handle('recent:list', async () => loadRecent());
ipcMain.handle('recent:add', async (e, p) => {
  const s = await loadSettings();
  let arr = await loadRecent();
  // 用户关闭“最近访问”后只保留历史数据，不再追加（重新开启后旧记录仍在）
  if (s.recentEnabled) {
    arr = arr.filter(x => x !== p);
    arr.unshift(p);
    arr = arr.slice(0, s.recentLimit);
    await saveRecent(arr, s.recentLimit);
  }
  return arr;
});
ipcMain.handle('recent:clear', async () => { await saveRecent([], 0); return []; });

// ============================================================
// IPC: 全局设置
// ============================================================
const SETTING_KEYS = ['startup', 'startupDir', 'lastDir', 'recentEnabled', 'recentLimit', 'closeToTray', 'showHidden', 'autoStart', 'rememberWindow', 'showAssocBadge'];
ipcMain.handle('settings:get', async () => ({ ...(await loadSettings()), version: app.getVersion() }));
ipcMain.handle('settings:set', async (e, patch) => {
  const clean = {};
  if (patch && typeof patch === 'object') {
    for (const k of SETTING_KEYS) if (k in patch) clean[k] = patch[k];
  }
  if ('startup' in clean && !['last', 'home', 'custom'].includes(clean.startup)) delete clean.startup;
  if ('startupDir' in clean && typeof clean.startupDir !== 'string') delete clean.startupDir;
  if ('lastDir' in clean && typeof clean.lastDir !== 'string') delete clean.lastDir;
  if ('recentLimit' in clean) {
    const n = Number(clean.recentLimit);
    // 用户可自填 0–10 的整数（0 = 不保留）；非法值回退默认 8
    clean.recentLimit = Number.isInteger(n) && n >= 0 && n <= 10 ? n : 8;
  }
  for (const k of ['recentEnabled', 'closeToTray', 'showHidden', 'autoStart', 'rememberWindow', 'showAssocBadge']) {
    if (k in clean && typeof clean[k] !== 'boolean') delete clean[k];
  }
  const saved = await saveSettings(clean);
  // 开机自启：同步写入 Windows 登录项
  if ('autoStart' in clean) {
    try { app.setLoginItemSettings({ openAtLogin: clean.autoStart, name: 'FileLinkManager' }); } catch { /* 忽略平台不支持 */ }
  }
  return saved;
});

// 复制文本到系统剪贴板（关于页反馈邮箱用）
ipcMain.handle('sys:copy', (e, text) => {
  try {
    sysClipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ============================================================
// IPC: Custom quick-access entries
// ============================================================
ipcMain.handle('quick:list', async () => loadQuick());

ipcMain.handle('quick:add', async (e, p) => {
  try {
    if (!p) return { ok: false, error: '缺少路径', ...(await loadQuick()) };
    const s = await fsp.stat(p);
    if (!s.isDirectory()) return { ok: false, error: '只能添加文件夹', ...(await loadQuick()) };
    const q = await loadQuick();
    const exists = q.custom.some(it => it.path.toLowerCase() === p.toLowerCase());
    if (!exists) {
      q.custom.push({ name: path.basename(p) || p, path: p });
      await saveQuick(q);
    }
    return { ok: true, ...q };
  } catch (err) {
    return { ok: false, error: err.message, ...(await loadQuick()) };
  }
});

// 自定义项：彻底移除；内置项：加入 hidden 列表（可恢复）
ipcMain.handle('quick:remove', async (e, p) => {
  const q = await loadQuick();
  q.custom = q.custom.filter(it => it.path !== p);
  await saveQuick(q);
  return { ok: true, ...q };
});

ipcMain.handle('quick:hide', async (e, p) => {
  const q = await loadQuick();
  if (!q.hidden.includes(p)) q.hidden.push(p);
  await saveQuick(q);
  return { ok: true, ...q };
});

ipcMain.handle('quick:restore', async () => {
  const q = await loadQuick();
  q.hidden = [];
  await saveQuick(q);
  return { ok: true, ...q };
});

// ============================================================
// IPC: File operations
// ============================================================
async function copyRecursive(src, dest) {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const e of entries) {
      await copyRecursive(path.join(src, e.name), path.join(dest, e.name));
    }
  } else {
    await fsp.copyFile(src, dest);
    await fsp.utimes(dest, stat.atime, stat.mtime);
  }
}

async function safeJoinName(folder, name) {
  let candidate = path.join(folder, name);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 2; i < 1000; i++) {
    const test = path.join(folder, `${base} (${i})${ext}`);
    if (!fs.existsSync(test)) return test;
  }
  return path.join(folder, `${Date.now()}_${name}`);
}

ipcMain.handle('clip:set', (e, items, mode) => {
  clipboard = { items: items || [], mode: mode === 'cut' ? 'cut' : 'copy' };
  return clipboard;
});
ipcMain.handle('clip:get', () => clipboard);

ipcMain.handle('op:paste', async (e, destDir) => {
  if (!clipboard.items.length) return { ok: false, error: 'Clipboard empty' };
  const results = [];
  const destLower = String(destDir).toLowerCase();
  for (const src of clipboard.items) {
    try {
      // 剪切时禁止把项目移入其自身或其子目录（资源管理器同样阻止，
      // 否则 copy 进自己内部再删除源会毁掉整棵目录树）
      if (clipboard.mode === 'cut') {
        const srcLower = String(src).toLowerCase();
        if (destLower === srcLower || destLower.startsWith(srcLower + path.sep)) {
          results.push({ ok: false, from: src, error: '目标文件夹位于待移动项目内部，已跳过' });
          continue;
        }
      }
      const name = path.basename(src);
      const target = await safeJoinName(destDir, name);
      await copyRecursive(src, target);
      if (clipboard.mode === 'cut') {
        await fsp.rm(src, { recursive: true, force: true });
      }
      results.push({ ok: true, from: src, to: target });
    } catch (err) {
      results.push({ ok: false, from: src, error: err.message });
    }
  }
  // 剪切：全部成功才清空剪贴板；有失败项则保留，便于换位置重新粘贴
  if (clipboard.mode === 'cut') {
    const failed = results.filter(x => !x.ok).map(x => x.from);
    clipboard = failed.length ? { items: failed, mode: 'cut' } : { items: [], mode: 'copy' };
  }
  return { ok: true, results };
});

// 拖拽移动/复制：把一批项目放入 destDir
// mode: 'move' 移动 | 'copy' 复制 | 'auto' 同盘移动、异盘复制（资源管理器默认规则）
ipcMain.handle('op:transfer', async (e, items, destDir, mode) => {
  const results = [];
  let destStat;
  try {
    destStat = await fsp.stat(destDir);
  } catch {
    return { ok: false, error: '目标文件夹不存在或无法访问', results: [] };
  }
  if (!destStat.isDirectory()) return { ok: false, error: '目标不是文件夹', results: [] };

  const sameVolume = (p) => path.parse(p).root.toLowerCase() === path.parse(destDir).root.toLowerCase();

  // 兼容单个路径字符串或路径数组
  const itemList = Array.isArray(items) ? items : (items ? [items] : []);
  for (const srcRaw of itemList) {
    const src = String(srcRaw || '');
    if (!src) continue;
    const srcLower = src.toLowerCase();
    const destLower = String(destDir).toLowerCase();
    // 统一的动作判定（auto：同盘移动、异盘复制）
    let action = mode === 'copy' ? 'copy' : mode === 'auto' ? (sameVolume(src) ? 'move' : 'copy') : 'move';
    try {
      const s = await fsp.stat(src);
      // 禁止：丢到自己身上、丢进自己内部（移动时会毁掉整棵子树）
      if (destLower === srcLower || (action === 'move' && destLower.startsWith(srcLower + path.sep))) {
        results.push({ ok: false, from: src, error: '目标位于待处理项目内部，已跳过' });
        continue;
      }
      // 已在目标文件夹内：移动无意义，复制则允许（safeJoinName 会生成“原名 (2)”）
      if (action === 'move' && path.dirname(src).toLowerCase() === destLower) {
        results.push({ ok: false, from: src, error: '项目已在该文件夹中' });
        continue;
      }
      const target = await safeJoinName(destDir, path.basename(src));
      if (action === 'move') {
        try {
          await fsp.rename(src, target); // 同盘原子操作，最快
        } catch (err) {
          if (err && (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES')) {
            // 跨卷/权限不允许 rename：复制后删除源（同剪切粘贴的兜底路径）
            action = 'copy';
            await copyRecursive(src, target);
            await fsp.rm(src, { recursive: true, force: true });
            action = 'move';
          } else {
            throw err;
          }
        }
      } else {
        await copyRecursive(src, target);
      }
      results.push({ ok: true, from: src, to: target, action });
    } catch (err) {
      results.push({ ok: false, from: src, error: err.message });
    }
  }
  return { ok: true, results };
});

ipcMain.handle('op:mkdir', async (e, parent) => {
  try {
    const name = await uniqueFolderName(parent, 'New folder');
    const full = path.join(parent, name);
    await fsp.mkdir(full, { recursive: true });
    return { ok: true, path: full };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

async function uniqueFolderName(parent, base) {
  let candidate = base;
  if (!fs.existsSync(path.join(parent, candidate))) return candidate;
  for (let i = 2; i < 1000; i++) {
    const t = `${base} (${i})`;
    if (!fs.existsSync(path.join(parent, t))) return t;
  }
  return `${base}_${Date.now()}`;
}

ipcMain.handle('op:rename', async (e, oldPath, newName) => {
  try {
    const dir = path.dirname(oldPath);
    const target = await safeJoinName(dir, newName);
    await fsp.rename(oldPath, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('op:delete', async (e, paths) => {
  const results = [];
  for (const p of paths) {
    try {
      await fsp.rm(p, { recursive: true, force: true });
      results.push({ ok: true, path: p });
    } catch (err) {
      results.push({ ok: false, path: p, error: err.message });
    }
  }
  return results;
});

ipcMain.handle('shell:reveal', (e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:open', (e, p) => shell.openPath(p));
// “打开方式”：调用 Windows 系统对话框（OpenAs_RunDLL），让用户挑选程序
ipcMain.handle('shell:openas', (e, p) => {
  return new Promise((resolve) => {
    const child = require('child_process').spawn(
      'rundll32.exe',
      ['shell32.dll,OpenAs_RunDLL', p],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }
    );
    child.once('spawn', () => resolve({ ok: true }));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    // rundll32 拉起系统对话框后即返回；解除引用避免其退出句柄影响主进程
    child.unref();
  });
});
ipcMain.handle('shell:trash', async (e, paths) => {
  // Use shell.trashItem for safe recycle-bin deletion.
  // Accept a single path or array of paths.
  const arr = Array.isArray(paths) ? paths : [paths];
  const errors = [];
  for (const p of arr) {
    try {
      await shell.trashItem(p);
    } catch (err) {
      errors.push({ path: p, error: err.message });
    }
  }
  return { ok: errors.length === 0, errors };
});

// ============================================================
// IPC: Associations (link related files together)
// ============================================================
ipcMain.handle('assoc:list', async (e, filePath) => {
  const db = await loadDb();
  return db[filePath] || [];
});

ipcMain.handle('assoc:add', async (e, filePath, relatedPath) => {
  if (!filePath || !relatedPath) return { ok: false, error: 'Missing paths' };
  const db = await loadDb();
  if (!db[filePath]) db[filePath] = [];
  if (!db[filePath].includes(relatedPath)) {
    db[filePath].push(relatedPath);
    await saveDb(db);
  }
  return { ok: true, related: db[filePath] };
});

ipcMain.handle('assoc:remove', async (e, filePath, relatedPath) => {
  const db = await loadDb();
  if (db[filePath]) {
    db[filePath] = db[filePath].filter(p => p !== relatedPath);
    if (db[filePath].length === 0) delete db[filePath];
    await saveDb(db);
  }
  return { ok: true, related: db[filePath] || [] };
});

// 批量取消关联：一次移除同一源文件下的多个关联目标
ipcMain.handle('assoc:removeMany', async (e, filePath, relatedPaths) => {
  const remove = new Set(Array.isArray(relatedPaths) ? relatedPaths.filter(p => typeof p === 'string') : []);
  if (!filePath || !remove.size) {
    const db0 = await loadDb();
    return { ok: true, related: db0[filePath] || [] };
  }
  const db = await loadDb();
  if (db[filePath]) {
    db[filePath] = db[filePath].filter(p => !remove.has(p));
    if (db[filePath].length === 0) delete db[filePath];
    await saveDb(db);
  }
  return { ok: true, related: db[filePath] || [] };
});

ipcMain.handle('assoc:pick', async (e, sourcePath) => {
  // 选择器初始目录：传入的是目录则直接使用（批量关联传当前目录）；
  // 传入的是文件则取其所在目录（单个源文件添加关联）
  let startDir;
  try {
    const st = await fsp.stat(sourcePath || '');
    startDir = st.isDirectory() ? sourcePath : path.dirname(sourcePath || '');
    await fsp.access(startDir, fs.constants.R_OK);
  } catch {
    startDir = app.getPath('home');
  }
  const parentWin = BrowserWindow.fromWebContents(e.sender);
  return await openPicker(parentWin, { startDir, mode: 'both', title: '选择要关联的文件或文件夹', target: sourcePath || '' });
});

// ============================================================
// 自定义选择器窗口（替代 Windows 原生对话框）
// - mode='both'：文件和文件夹同框多选、跨目录累积（添加关联用）
// - mode='dir' ：仅文件夹，单选“当前所在文件夹”（快速访问/设置用）
// 返回绝对路径数组（取消返回 []）。
// ============================================================
let pickerResolve = null;
function openPicker(parentWin, opts = {}) {
  const startDir = opts.startDir || '';
  const mode = opts.mode === 'dir' ? 'dir' : 'both';
  const target = opts.target || '';
  const title = opts.title || '选择文件或文件夹';
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1080,
      height: 680,
      minWidth: 880,
      minHeight: 480,
      title,
      backgroundColor: '#0a0a0a',
      parent: parentWin || undefined,
      modal: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    pickerResolve = resolve;
    // 关闭窗口（×、Esc）一律视为取消
    win.on('closed', () => {
      if (pickerResolve) { pickerResolve([]); pickerResolve = null; }
    });
    const q = '?dir=' + encodeURIComponent(startDir) + '&mode=' + encodeURIComponent(mode)
      + '&target=' + encodeURIComponent(target);
    win.loadFile(path.join(__dirname, 'renderer', 'picker.html'), { search: q });
  });
}
ipcMain.on('picker:confirm', (e, paths) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const arr = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p) : [];
  if (pickerResolve) { pickerResolve(arr); pickerResolve = null; }
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.on('picker:cancel', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (pickerResolve) { pickerResolve([]); pickerResolve = null; }
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('assoc:search', async (e, filePath) => {
  // Reverse lookup: find files that link to filePath
  const db = await loadDb();
  const refs = [];
  for (const [k, list] of Object.entries(db)) {
    if (list.includes(filePath)) refs.push(k);
  }
  return refs;
});

// Relationship graph: bidirectional BFS from a center item.
// Returns directed edges + nodes (up to 2 hops, capped) for the graph panel.
ipcMain.handle('assoc:graph', async (e, centerPath) => {
  try {
    if (!centerPath) return { ok: false, error: '缺少路径' };
    const db = await loadDb();

    // Build reverse index once (path -> items that link to it)
    const rev = new Map();
    for (const [k, list] of Object.entries(db)) {
      if (!Array.isArray(list)) continue;
      for (const q of list) {
        if (!rev.has(q)) rev.set(q, []);
        rev.get(q).push(k);
      }
    }

    const MAX_DEPTH = 2;
    const MAX_NODES = 60;
    const SEP = String.fromCharCode(0); // NUL can never occur in a file path
    const depth = new Map([[centerPath, 0]]);
    const parent = new Map();
    const edgeSet = new Set();
    const queue = [centerPath];

    while (queue.length && depth.size <= MAX_NODES) {
      const p = queue.shift();
      const d = depth.get(p);
      if (d >= MAX_DEPTH) continue;
      const discover = (q) => {
        if (!depth.has(q)) {
          depth.set(q, d + 1);
          parent.set(q, p);
          queue.push(q);
        }
      };
      for (const q of (db[p] || [])) {
        edgeSet.add(p + SEP + q);
        discover(q);
        if (depth.size > MAX_NODES) break;
      }
      for (const k of (rev.get(p) || [])) {
        edgeSet.add(k + SEP + p);
        discover(k);
        if (depth.size > MAX_NODES) break;
      }
    }

    const nodes = [];
    for (const [p, d] of depth) {
      let isDir = false, missing = false;
      try {
        const s = await fsp.stat(p);
        isDir = s.isDirectory();
      } catch {
        missing = true;
      }
      nodes.push({
        path: p,
        name: path.basename(p) || p,
        depth: d,
        isDir,
        missing,
        parent: parent.get(p) || null
      });
    }

    const edges = [...edgeSet]
      .map(s => { const i = s.indexOf(SEP); return { from: s.slice(0, i), to: s.slice(i + 1) }; })
      .filter(e => depth.has(e.from) && depth.has(e.to));

    return { ok: true, center: centerPath, nodes, edges, truncated: depth.size > MAX_NODES };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stat:file', async (e, p) => {
  try {
    const s = await fsp.stat(p);
    return {
      ok: true,
      size: s.size,
      mtime: s.mtimeMs,
      isDir: s.isDirectory(),
      ext: s.isDirectory() ? '' : path.extname(p).toLowerCase()
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ============================================================
// IPC: 关联数据备份 / 恢复（升级软件前保存链接）
// 备份文件为带版本标记的 JSON；恢复支持 合并(默认) / 覆盖
// ============================================================
function countLinks(db) {
  let n = 0;
  for (const list of Object.values(db || {})) if (Array.isArray(list)) n += list.length;
  return n;
}

ipcMain.handle('backup:export', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: '备份关联链接',
    defaultPath: `FileLinkManager-links-${stamp}.json`,
    filters: [{ name: 'JSON 备份文件', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const db = await loadDb();
  const payload = {
    app: 'FileLinkManager',
    kind: 'links-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    linkCount: countLinks(db),
    data: db
  };
  try {
    await fsp.writeFile(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: r.filePath, items: Object.keys(db).length, links: payload.linkCount };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:import', async (e, mode) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '恢复关联链接',
    properties: ['openFile'],
    filters: [{ name: 'JSON 备份文件', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
  } catch (err) {
    return { ok: false, error: '文件不是有效的备份（无法解析 JSON）：' + err.message };
  }
  // 兼容本程序导出的带壳格式，也兼容裸 associations.json（直接是对象）
  const incoming = parsed && parsed.kind === 'links-backup' && parsed.data && typeof parsed.data === 'object'
    ? parsed.data
    : (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
  if (!incoming) return { ok: false, error: '备份内容格式不正确，缺少关联数据' };

  const cur = await loadDb();
  let merged;
  if (mode === 'replace') {
    merged = {};
  } else {
    // 深拷贝当前库，避免下面的就地修改影响缓存对象
    merged = {};
    for (const [k, list] of Object.entries(cur)) merged[k] = Array.isArray(list) ? list.slice() : [];
  }
  let addedLinks = 0;
  for (const [src, list] of Object.entries(incoming)) {
    if (typeof src !== 'string' || !Array.isArray(list)) continue;
    if (!merged[src]) merged[src] = [];
    for (const target of list) {
      if (typeof target !== 'string' || !target) continue;
      if (!merged[src].includes(target)) { merged[src].push(target); addedLinks++; }
    }
    if (merged[src].length === 0) delete merged[src];
  }
  await saveDb(merged);
  return {
    ok: true,
    mode: mode === 'replace' ? 'replace' : 'merge',
    items: Object.keys(merged).length,
    links: countLinks(merged),
    addedLinks
  };
});
