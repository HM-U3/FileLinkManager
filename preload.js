const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');
const os = require('os');

// Path helpers (no Node access in renderer, expose safe utilities)
const pathUtils = {
  basename: (p) => p ? path.basename(p) : '',
  dirname: (p) => p ? path.dirname(p) : '',
  extname: (p) => p ? path.extname(p).toLowerCase() : '',
  join: (...a) => path.join(...a),
  sep: path.sep
};

const home = os.homedir();
const quickPaths = {
  desktop: path.join(home, 'Desktop'),
  documents: path.join(home, 'Documents'),
  downloads: path.join(home, 'Downloads'),
  pictures: path.join(home, 'Pictures'),
  music: path.join(home, 'Music'),
  videos: path.join(home, 'Videos'),
  home
};

contextBridge.exposeInMainWorld('api', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close')
  },
  path: pathUtils,
  quickPaths,
  dir: {
    list: (p) => ipcRenderer.invoke('dir:list', p),
    home: () => ipcRenderer.invoke('dir:home'),
    drives: () => ipcRenderer.invoke('dir:drives'),
    pick: () => ipcRenderer.invoke('dir:pick'),
    parent: (p) => ipcRenderer.invoke('dir:parent', p)
  },
  recent: {
    list: () => ipcRenderer.invoke('recent:list'),
    add: (p) => ipcRenderer.invoke('recent:add', p),
    clear: () => ipcRenderer.invoke('recent:clear')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  quick: {
    list: () => ipcRenderer.invoke('quick:list'),
    add: (p) => ipcRenderer.invoke('quick:add', p),
    remove: (p) => ipcRenderer.invoke('quick:remove', p),
    hide: (p) => ipcRenderer.invoke('quick:hide', p),
    restore: () => ipcRenderer.invoke('quick:restore')
  },
  clip: {
    set: (items, mode) => ipcRenderer.invoke('clip:set', items, mode),
    get: () => ipcRenderer.invoke('clip:get')
  },
  op: {
    paste: (dest) => ipcRenderer.invoke('op:paste', dest),
    mkdir: (parent) => ipcRenderer.invoke('op:mkdir', parent),
    rename: (oldPath, newName) => ipcRenderer.invoke('op:rename', oldPath, newName),
    delete: (paths) => ipcRenderer.invoke('op:delete', paths),
    // 拖拽落点：把 items 移动/复制进 destDir（mode: move/copy/auto）
    transfer: (items, destDir, mode) => ipcRenderer.invoke('op:transfer', items, destDir, mode)
  },
  // pathForFile：读取从系统拖入本窗口文件的真实磁盘路径
  dnd: {
    pathForFile: (f) => webUtils.getPathForFile(f)
  },
  shell: {
    reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
    open: (p) => ipcRenderer.invoke('shell:open', p),
    openAs: (p) => ipcRenderer.invoke('shell:openas', p),
    trash: (paths) => ipcRenderer.invoke('shell:trash', paths)
  },
  assoc: {
    list: (filePath) => ipcRenderer.invoke('assoc:list', filePath),
    add: (filePath, relatedPath) => ipcRenderer.invoke('assoc:add', filePath, relatedPath),
    remove: (filePath, relatedPath) => ipcRenderer.invoke('assoc:remove', filePath, relatedPath),
    removeMany: (filePath, relatedPaths) => ipcRenderer.invoke('assoc:removeMany', filePath, relatedPaths),
    pick: (filePath) => ipcRenderer.invoke('assoc:pick', filePath),
    search: (filePath) => ipcRenderer.invoke('assoc:search', filePath),
    graph: (filePath) => ipcRenderer.invoke('assoc:graph', filePath),
    pruneMissing: () => ipcRenderer.invoke('assoc:pruneMissing'),
    relink: (oldPath) => ipcRenderer.invoke('assoc:relink', oldPath)
  },
  // 关联链接备份 / 恢复（升级软件前保存）
  backup: {
    exportLinks: () => ipcRenderer.invoke('backup:export'),
    importLinks: (mode) => ipcRenderer.invoke('backup:import', mode)
  },
  stat: {
    file: (p) => ipcRenderer.invoke('stat:file', p)
  },
  // 系统能力（剪贴板等）
  sys: {
    copyText: (text) => ipcRenderer.invoke('sys:copy', text)
  },
  // 自定义“文件/文件夹混合选择器”窗口使用
  picker: {
    confirm: (paths) => ipcRenderer.send('picker:confirm', paths),
    cancel: () => ipcRenderer.send('picker:cancel')
  }
});
