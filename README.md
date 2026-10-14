# FileLinkManager · 文件关联管理器

一款 Windows 桌面文件管理器，核心能力是给**任意文件 / 文件夹建立关联链接**：把图纸和技术要求、视频和课件、合同和扫描件……双向链在一起，在侧边栏一键查看与打开，再也不靠文件夹层级硬记。

- 纯本地运行，关联数据保存在本机，不上传任何服务器
- Electron + 原生 HTML / CSS / JavaScript，无前端框架
- 打包为单个 64 位 Windows 便携版 exe，免安装

## 功能特性

**文件关联**
- 为文件 / 文件夹添加一个或多个关联项目，关联关系**双向可见**（A 关联了 B，在 B 处也能看到 A）
- 右侧关联侧边栏：打开关联项、在资源管理器中定位、取消关联（支持 Ctrl 多选后批量取消）
- 入向关联角标、关联搜索、关系图视图
- 选择关联文件的弹窗支持：
  - 按住鼠标左键**拖框多选**
  - `Ctrl` 点击 / 拖框叠加，`Shift` 区间连选
  - 跨目录累积勾选

**文件浏览**
- 网格 / 列表两种视图，图标大小可调，按名称 / 修改日期 / 类型 / 大小排序
- 列表视图表头列宽可**拖拽调整并自动记忆**，长文件名可拖宽后横向查看全名
- 窗口内文件拖拽移动 / 复制（`Ctrl` 拖 = 复制）、侧边栏与地址栏拖放、外部文件拖入
- 后退 / 上级、面包屑地址栏、最近访问、快捷收藏、文件夹书签

**数据与设置**
- 设置中一键**备份当前链接**为 JSON 文件；升级或重装后可**恢复备份**（合并去重 / 整体覆盖）
- 开机自启、关闭到托盘、记住窗口大小与位置

## 从源码运行

环境要求：[Node.js](https://nodejs.org/) ≥ 18（建议 20/24 LTS）、Windows 10/11 x64。

```bash
# 安装依赖
npm install

# 开发模式启动
npm start
```

## 打包便携版

```bash
npm run dist:portable
```

产物在 `dist\FileLinkManager-Portable-<版本号>.exe`，单个文件，复制到任意位置双击即可运行。

> 国内网络下若 electron 二进制下载慢，可设置镜像：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> ```

## 数据存在哪里

打包版的关联数据位于：

```
%APPDATA%\FileLinkManager\filelink\
├─ associations.json   # 关联关系主数据：{ 源路径: [关联路径, ...] }
├─ recent.json         # 最近访问
├─ quick.json          # 快捷收藏 / 书签
└─ settings.json       # 设置项
```

升级软件前，在「设置 → 关联数据备份」中导出备份文件；升级后用「恢复备份」即可找回全部链接。

## 项目结构

```
├─ main.js          # Electron 主进程：窗口、IPC、文件操作、关联数据存取、备份恢复
├─ preload.js       # 上下文隔离桥（contextBridge 暴露安全 API）
├─ renderer/
│  ├─ index.html    # 主窗口界面
│  ├─ app.js        # 主窗口逻辑：浏览、选择、拖拽、关联、列宽、设置
│  ├─ styles.css    # 主窗口样式
│  ├─ picker.html   # “选择关联文件”弹窗
│  ├─ picker.js     # 弹窗逻辑（含拖框多选）
│  └─ picker.css
├─ assets/          # 托盘图标等资源
└─ package.json
```

## 开源协议

[MIT](LICENSE) © HM-U3
