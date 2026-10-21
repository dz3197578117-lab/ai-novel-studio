/**
 * NovelForge 桌面版主进程。
 *
 * 做的事很少：起一个只监听 127.0.0.1 随机端口的本地服务，
 * 再用一个 Chromium 窗口把它包起来。前端代码一行没改——仍然是那套 SPA，
 * 只是用户看到的是独立窗口，而不是浏览器标签页。
 *
 * 数据目录沿用 %APPDATA%\NovelForge，和便携版 exe 完全共用：
 * 两边可以互相打开同一份作品（但不要同时开两个进程）。
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已经有一个实例在跑：直接退出，由那个实例把窗口拉到前台
  app.quit();
} else {
  main();
}

function main() {
  app.setAppUserModelId('com.novelforge.desktop');

  let mainWindow = null;
  let serverHandle = null;
  let quitting = false;

  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

  function loadWindowState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {};
    }
  }

  function saveWindowState(win) {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(
        stateFile(),
        JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }),
        'utf8',
      );
    } catch {
      /* 窗口位置记不住不影响使用 */
    }
  }

  /**
   * 启动内置服务。
   * 环境变量必须在 require 之前设置：config.ts 在模块加载时就会读它们。
   */
  async function startServer() {
    process.env.NODE_ENV = 'production';
    process.env.NOVELFORGE_NO_OPEN = '1';
    process.env.NOVELFORGE_DATA_DIR = app.getPath('userData');
    process.env.NOVELFORGE_WEB_DIR = app.isPackaged
      ? path.join(process.resourcesPath, 'web')
      : path.resolve(__dirname, '../web/dist');

    if (process.env.NOVELFORGE_DISABLE_GPU === '1') app.disableHardwareAcceleration();

    // server.cjs 由 scripts/build-desktop.mjs 用 esbuild 打出来
    const { startForDesktop } = require(path.join(__dirname, 'build', 'server.cjs'));
    return startForDesktop();
  }

  function buildMenu() {
    // 默认菜单是英文且带 DevTools，换成只保留编辑/视图的精简菜单
    const template = [
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '进入全屏' },
          {
            label: '开发者工具',
            accelerator: 'F12',
            click: () => mainWindow?.webContents.toggleDevTools(),
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function createWindow(url) {
    const saved = loadWindowState();
    mainWindow = new BrowserWindow({
      width: saved.width ?? 1440,
      height: saved.height ?? 920,
      x: saved.x,
      y: saved.y,
      minWidth: 1024,
      minHeight: 680,
      title: 'NovelForge',
      backgroundColor: '#12100e',
      autoHideMenuBar: true,
      show: false,
      icon: path.join(__dirname, 'resources', 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', () => saveWindowState(mainWindow));
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // 页面里的外链（比如资料出处）交给系统浏览器，不在应用内开新窗口
    mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, target) => {
      if (!target.startsWith(url)) {
        event.preventDefault();
        if (/^https?:/i.test(target)) void shell.openExternal(target);
      }
    });

    void mainWindow.loadURL(url);
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      serverHandle = await startServer();
      createWindow(serverHandle.url);
      // 冒烟测试用：加载完就打印标题并退出，便于在无头环境验证
      if (process.env.NOVELFORGE_SMOKE === '1') {
        mainWindow.webContents.once('did-finish-load', async () => {
          const title = await mainWindow.webContents.executeJavaScript('document.title');
          const rootFilled = await mainWindow.webContents.executeJavaScript(
            'Boolean(document.querySelector("#root") && document.querySelector("#root").children.length)',
          );
          console.log(`[smoke] title=${title} root=${rootFilled} url=${serverHandle.url}`);
          setTimeout(() => app.quit(), 300);
        });
      }
    } catch (err) {
      dialog.showErrorBox(
        'NovelForge 启动失败',
        `${(err && err.stack) || err}\n\n数据目录：${app.getPath('userData')}`,
      );
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    // 桌面版没有「后台常驻」需求，关窗即退出
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting || !serverHandle) return;
    event.preventDefault();
    quitting = true;
    // 先关服务再退出：让 SQLite 有机会把 WAL 落盘
    serverHandle
      .close()
      .catch(() => {})
      .finally(() => app.quit());
  });
}
