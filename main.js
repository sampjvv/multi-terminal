const { app, BrowserWindow, ipcMain, clipboard, nativeTheme } = require('electron');
const path = require('path');
const pty = require('node-pty');

let mainWindow;
const ptys = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'SPTC',
    backgroundColor: '#09090b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#09090b',
      symbolColor: '#fafafa',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const [id, ptyProcess] of ptys) {
    ptyProcess.kill();
  }
  ptys.clear();
  app.quit();
});

ipcMain.handle('pty:create', (event, { id, cols, rows }) => {
  const shell = 'powershell.exe';
  const cwd = process.env.USERPROFILE || process.env.HOME;

  // Delete ALL Claude Code env vars to prevent nested-session detection
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
      delete cleanEnv[key];
    }
  }

  const ptyProcess = pty.spawn(shell, [
    '-NoExit', '-Command',
    'function prompt { $p = $PWD.Path; "$([char]27)]0;$p$([char]7)PS $p> " }'
  ], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: cleanEnv,
    useConptyDll: true,
  });

  ptys.set(id, ptyProcess);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode });
    }
  });

  return { success: true, cwd };
});

ipcMain.handle('pty:write', (event, { id, data }) => {
  const ptyProcess = ptys.get(id);
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

ipcMain.handle('pty:resize', (event, { id, cols, rows }) => {
  const ptyProcess = ptys.get(id);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

ipcMain.handle('pty:destroy', (event, { id }) => {
  const ptyProcess = ptys.get(id);
  if (ptyProcess) {
    ptyProcess.kill();
    ptys.delete(id);
  }
});

ipcMain.handle('clipboard:read', () => {
  return clipboard.readText();
});

ipcMain.handle('clipboard:write', (event, { text }) => {
  clipboard.writeText(text);
});

ipcMain.handle('theme:set', (event, { theme }) => {
  nativeTheme.themeSource = theme;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay({
      color: theme === 'dark' ? '#09090b' : '#fafafa',
      symbolColor: theme === 'dark' ? '#fafafa' : '#09090b',
    });
  }
});

ipcMain.handle('window:toggleFullscreen', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }
});

// pty:getCwd kept for compatibility but no longer polled — CWD comes via OSC 9;9
ipcMain.handle('pty:getCwd', (event, { id }) => {
  const ptyProcess = ptys.get(id);
  if (ptyProcess) {
    return ptyProcess.process || '';
  }
  return '';
});
