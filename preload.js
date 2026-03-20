const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pty', {
  create: (id, cols, rows, cwd) => ipcRenderer.invoke('pty:create', { id, cols, rows, cwd }),
  write: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
  destroy: (id) => ipcRenderer.invoke('pty:destroy', { id }),
  getCwd: (id) => ipcRenderer.invoke('pty:getCwd', { id }),
  onData: (callback) => ipcRenderer.on('pty:data', (event, { id, data }) => callback(id, data)),
  onExit: (callback) => ipcRenderer.on('pty:exit', (event, { id, exitCode }) => callback(id, exitCode)),
});

contextBridge.exposeInMainWorld('clipboardBridge', {
  read: () => ipcRenderer.invoke('clipboard:read'),
  write: (text) => ipcRenderer.invoke('clipboard:write', { text }),
});

contextBridge.exposeInMainWorld('themeBridge', {
  setNativeTheme: (theme) => ipcRenderer.invoke('theme:set', { theme }),
});

contextBridge.exposeInMainWorld('windowControl', {
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  setFullscreen: (fullscreen) => ipcRenderer.invoke('window:setFullscreen', { fullscreen }),
  onFullscreenChanged: (callback) => ipcRenderer.on('window:fullscreenChanged', (event, isFullScreen) => callback(isFullScreen)),
});

contextBridge.exposeInMainWorld('dialogBridge', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
});

contextBridge.exposeInMainWorld('appBridge', {
  getHomeDir: () => ipcRenderer.invoke('app:getHomeDir'),
});

contextBridge.exposeInMainWorld('serverBridge', {
  onUrl: (callback) => ipcRenderer.on('server:url', (event, info) => callback(info)),
});

contextBridge.exposeInMainWorld('tunnelBridge', {
  start: () => ipcRenderer.invoke('tunnel:start'),
  stop: () => ipcRenderer.invoke('tunnel:stop'),
  onUrl: (cb) => ipcRenderer.on('tunnel:url', (e, url) => cb(url)),
  onStopped: (cb) => ipcRenderer.on('tunnel:stopped', () => cb()),
});
