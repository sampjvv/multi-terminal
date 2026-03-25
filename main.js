const { app, BrowserWindow, ipcMain, clipboard, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const pty = require('node-pty');
const server = require('./server');

function getOrCreateAuthKey() {
  const keyPath = path.join(app.getPath('userData'), 'auth-key.txt');
  try {
    const key = fs.readFileSync(keyPath, 'utf8').trim();
    if (key.length >= 32) return key;
  } catch {}
  const key = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, 'utf8');
  return key;
}

let mainWindow;
let serverPort = null;
let tunnelProcess = null;
let tunnelUrl = null;
let authToken = null;
let tunnelManualStop = false;
const ptys = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'creampuff',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#fafafa',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#fafafa',
      symbolColor: '#09090b',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile('index.html');

  // Persist fullscreen state
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreenChanged', true);
    }
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:fullscreenChanged', false);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (serverPort) {
      mainWindow.webContents.send('server:url', { port: serverPort, token: authToken });
    }
    if (tunnelUrl) {
      mainWindow.webContents.send('tunnel:url', tunnelUrl);
    }
  });
}

app.whenReady().then(async () => {
  createWindow();

  // Auto-launch on startup
  app.setLoginItemSettings({ openAtLogin: true });

  // Start mobile remote access server with persistent auth key
  try {
    const persistentKey = getOrCreateAuthKey();
    const result = await server.start(3333, (id, data) => {
      const p = ptys.get(id);
      if (p) p.write(data);
    }, (id, cols, rows) => {
      const p = ptys.get(id);
      if (p) p.resize(cols, rows);
    }, persistentKey);
    serverPort = result.port;
    authToken = result.token;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server:url', { port: serverPort, token: authToken });
    }
    startTunnel();
  } catch (err) {
    console.error('Failed to start mobile server:', err);
  }
});

function findCloudflared() {
  try {
    execFileSync('where', ['cloudflared'], { stdio: 'ignore' });
    return 'cloudflared';
  } catch {}
  // Check common locations
  const homeBin = path.join(process.env.USERPROFILE || process.env.HOME || '', 'bin', 'cloudflared.exe');
  try {
    require('fs').accessSync(homeBin);
    return homeBin;
  } catch {}
  return null;
}

function startTunnel() {
  if (tunnelProcess) return;
  tunnelManualStop = false;

  const cloudflaredPath = findCloudflared();
  if (!cloudflaredPath) {
    console.log('cloudflared not found — tunnel disabled (LAN-only mode)');
    return;
  }

  tunnelProcess = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${serverPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const handleOutput = (data) => {
    const line = data.toString();
    const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      tunnelUrl = `${match[0]}/?token=${authToken}`;
      // Write URL to temp file for debugging/remote access
      const fs = require('fs');
      const urlFile = path.join(require('os').tmpdir(), 'creampuff-tunnel-url.txt');
      fs.writeFileSync(urlFile, tunnelUrl, 'utf8');
      console.log('Tunnel URL:', tunnelUrl);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel:url', tunnelUrl);
      }
    }
  };

  tunnelProcess.stdout.on('data', handleOutput);
  tunnelProcess.stderr.on('data', handleOutput);

  tunnelProcess.on('exit', (code) => {
    console.log(`cloudflared exited with code ${code}`);
    tunnelProcess = null;
    tunnelUrl = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tunnel:stopped');
    }
    // Auto-restart after delay unless manually stopped or quitting
    if (!tunnelManualStop && !app.isQuitting) {
      setTimeout(startTunnel, 5000);
    }
  });
}

function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    tunnelUrl = null;
  }
}

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('window-all-closed', () => {
  stopTunnel();
  server.stop();
  for (const [id, ptyProcess] of ptys) {
    ptyProcess.kill();
  }
  ptys.clear();
  app.quit();
});

ipcMain.handle('pty:create', (event, { id, cols, rows, cwd }) => {
  const shell = 'powershell.exe';
  const resolvedCwd = cwd || process.env.USERPROFILE || process.env.HOME;

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
    cwd: resolvedCwd,
    env: cleanEnv,
    useConptyDll: true,
  });

  ptys.set(id, ptyProcess);
  server.onPaneCreated(id, resolvedCwd);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
    server.onPaneData(id, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    ptys.delete(id);
    server.onPaneExited(id);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode });
    }
  });

  return { success: true, cwd: resolvedCwd };
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
    server.onPaneExited(id);
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

ipcMain.handle('window:setFullscreen', (event, { fullscreen }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(fullscreen);
  }
});

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose a directory',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('app:getHomeDir', () => {
  return process.env.USERPROFILE || process.env.HOME;
});

ipcMain.handle('tunnel:start', () => {
  startTunnel();
});

ipcMain.handle('tunnel:stop', () => {
  tunnelManualStop = true;
  stopTunnel();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tunnel:stopped');
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
