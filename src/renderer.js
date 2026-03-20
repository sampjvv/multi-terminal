const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const MAX_PANES = 16;
const panes = new Map();
let activeId = null;
let nextId = 1;
let currentTheme = localStorage.getItem('creampuff-theme') || 'light';
let backtickPending = false;
let backtickTimer = null;
let backtickHeld = false;

// Shift+1-6 produce these characters for panes 11-16
const SHIFT_DIGIT_MAP = { '!': 11, '@': 12, '#': 13, '$': 14, '%': 15, '^': 16 };

const grid = document.getElementById('terminal-grid');
const countDisplay = document.getElementById('pane-count');

const themes = {
  dark: {
    background: '#0c0c0e',
    foreground: '#e4e4e7',
    cursor: '#d4d4d8',
    cursorAccent: '#0c0c0e',
    selectionBackground: 'rgba(161, 161, 170, 0.3)',
    selectionForeground: '#fafafa',
    black: '#27272a',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e4e4e7',
    brightBlack: '#52525b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa',
  },
  light: {
    background: '#ffffff',
    foreground: '#18181b',
    cursor: '#3f3f46',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(63, 63, 70, 0.15)',
    selectionForeground: '#09090b',
    black: '#09090b',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#e4e4e7',
    brightBlack: '#71717a',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#fafafa',
  },
};

// ── Recent directories manager ──
function getRecentDirs() {
  try {
    return JSON.parse(localStorage.getItem('creampuff-recent-dirs')) || [];
  } catch {
    return [];
  }
}

function addRecentDir(dir) {
  const normalized = dir.replace(/\\/g, '/').toLowerCase();
  let dirs = getRecentDirs().filter(
    (d) => d.replace(/\\/g, '/').toLowerCase() !== normalized
  );
  dirs.unshift(dir);
  if (dirs.length > 10) dirs = dirs.slice(0, 10);
  localStorage.setItem('creampuff-recent-dirs', JSON.stringify(dirs));
}

// ── Grid / pane helpers ──
function updateCount() {
  countDisplay.textContent = `${panes.size} / ${MAX_PANES}`;
  const count = panes.size;
  if (count === 0) {
    grid.style.gridTemplateColumns = '1fr';
    grid.style.gridTemplateRows = '1fr';
    return;
  }

  let cols;
  if (count <= 1) cols = 1;
  else if (count <= 4) cols = 2;
  else if (count <= 9) cols = Math.min(4, Math.ceil(count / 2));
  else cols = 4;
  if (cols === 5 || cols === 6) cols = 4;

  const fullRows = Math.floor(count / cols);
  const remainder = count % cols;
  const numRows = remainder > 0 ? fullRows + 1 : fullRows;

  grid.style.gridTemplateColumns = 'repeat(12, 1fr)';
  grid.style.gridTemplateRows = `repeat(${numRows}, 1fr)`;

  let paneIndex = 0;
  const paneEls = [...panes.values()];
  for (let row = 0; row < numRows; row++) {
    const isLastRow = row === numRows - 1 && remainder > 0;
    const panesInRow = isLastRow ? remainder : cols;
    const span = 12 / panesInRow;
    for (let col = 0; col < panesInRow; col++) {
      if (paneIndex < paneEls.length) {
        paneEls[paneIndex].element.style.gridColumn = `span ${span}`;
        paneIndex++;
      }
    }
  }
}

function renumberPanes() {
  let idx = 1;
  for (const [, pane] of panes) {
    const label = pane.element.querySelector('.pane-number');
    if (label) label.textContent = idx;
    idx++;
  }
}

function setActive(id) {
  if (activeId) {
    const prev = panes.get(activeId);
    if (prev) prev.element.classList.remove('active');
  }
  activeId = id;
  const pane = panes.get(id);
  if (pane) {
    pane.element.classList.add('active');
    if (pane.terminal) pane.terminal.focus();
  }
}

function shortenPath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/^C:\/Users\/[^/]+/, '~');
}

// ── Directory picker overlay ──
async function showDirectoryPicker(id, container, pathLabel) {
  const homeDir = await window.appBridge.getHomeDir();
  const recentDirs = getRecentDirs();

  // Build directory list: home first, then recents (excluding home)
  const homeNorm = homeDir.replace(/\\/g, '/').toLowerCase();
  const dirs = [homeDir];
  for (const d of recentDirs) {
    if (d.replace(/\\/g, '/').toLowerCase() !== homeNorm) {
      dirs.push(d);
    }
  }

  let selectedIndex = 0;

  // Build overlay DOM
  const overlay = document.createElement('div');
  overlay.className = 'dir-picker-overlay';

  const card = document.createElement('div');
  card.className = 'dir-picker-card';

  const title = document.createElement('h3');
  title.className = 'dir-picker-title';
  title.textContent = 'Choose a directory';

  const list = document.createElement('div');
  list.className = 'dir-picker-list';

  function renderItems() {
    list.innerHTML = '';
    dirs.forEach((dir, i) => {
      const item = document.createElement('div');
      item.className = 'dir-picker-item' + (i === selectedIndex ? ' selected' : '');

      const pathSpan = document.createElement('span');
      pathSpan.className = 'dir-picker-path';
      pathSpan.textContent = shortenPath(dir);

      item.appendChild(pathSpan);

      if (i === 0) {
        const badge = document.createElement('span');
        badge.className = 'dir-picker-badge';
        badge.textContent = 'home';
        item.appendChild(badge);
      }

      item.addEventListener('click', () => confirmDir(dir));
      list.appendChild(item);
    });
  }

  const terminalBtn = document.createElement('button');
  terminalBtn.className = 'dir-picker-browse';
  terminalBtn.textContent = 'Terminal only (no Claude)';
  terminalBtn.addEventListener('click', () => {
    confirmDir(dirs[selectedIndex], false);
  });

  card.appendChild(title);
  card.appendChild(list);
  card.appendChild(terminalBtn);
  overlay.appendChild(card);
  container.appendChild(overlay);

  renderItems();

  function confirmDir(dir, runClaude = true) {
    cleanup();
    initTerminalInPane(id, dir, container, pathLabel, runClaude);
  }

  function onKeyDown(e) {
    // Only handle if this pane's overlay is showing
    if (!overlay.parentNode) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % dirs.length;
      renderItems();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + dirs.length) % dirs.length;
      renderItems();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmDir(dirs[selectedIndex]);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      terminalBtn.focus();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (panes.size <= 1) {
        // Only pane — select home
        confirmDir(homeDir);
      } else {
        // Close pane
        cleanup();
        removePane(id);
      }
      return;
    }
  }

  function cleanup() {
    document.removeEventListener('keydown', onKeyDown, true);
    if (overlay.parentNode) overlay.remove();
  }

  document.addEventListener('keydown', onKeyDown, true);
}

// ── Initialize terminal in pane (Phase 3) ──
async function initTerminalInPane(id, cwd, container, pathLabel, runClaude = true) {
  addRecentDir(cwd);

  const terminal = new Terminal({
    fontSize: 13,
    fontFamily: "'Cascadia Code', 'Cascadia Mono', 'Consolas', monospace",
    theme: themes[currentTheme],
    cursorBlink: true,
    allowProposedApi: true,
    rightClickSelectsWord: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  terminal.onTitleChange((title) => {
    if (pathLabel && title) {
      pathLabel.textContent = shortenPath(title);
    }
  });

  // Right-click context menu: copy selection or paste
  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const selection = terminal.getSelection();
    if (selection) {
      await navigator.clipboard.writeText(selection);
      terminal.clearSelection();
    } else {
      const text = await navigator.clipboard.readText();
      if (text) {
        window.pty.write(id, text);
      }
    }
  });

  // Copy/paste key handlers
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    if (e.ctrlKey && e.shiftKey) {
      if (e.key === 'C') {
        const sel = terminal.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }
      if (e.key === 'V') {
        navigator.clipboard.readText().then((text) => {
          if (text) window.pty.write(id, text);
        });
        return false;
      }
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      const sel = terminal.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel);
        terminal.clearSelection();
        return false;
      }
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then((text) => {
        if (text) window.pty.write(id, text);
      });
      return false;
    }

    if (e.key === 'F11') {
      return false;
    }

    if (e.key === '`') {
      return false;
    }

    if (backtickPending) {
      const k = e.key;
      if (k === 't' || k === 'T' || k === 'w' || k === 'W' || k === 'e' || k === 'E') {
        return false;
      }
      if ((k >= '1' && k <= '9') || k === '0') {
        return false;
      }
      if (SHIFT_DIGIT_MAP[k] !== undefined) {
        return false;
      }
    }

    return true;
  });

  await new Promise((r) => setTimeout(r, 50));
  fitAddon.fit();

  const cols = terminal.cols;
  const rows = terminal.rows;

  const result = await window.pty.create(id, cols, rows, cwd);
  if (result.cwd) {
    pathLabel.textContent = shortenPath(result.cwd);
  }

  terminal.onData((data) => {
    window.pty.write(id, data);
  });

  // Update pane record
  const pane = panes.get(id);
  if (pane) {
    pane.terminal = terminal;
    pane.fitAddon = fitAddon;
  }

  setActive(id);
  requestAnimationFrame(() => fitAll());

  if (runClaude) {
    setTimeout(() => {
      window.pty.write(id, 'claude\r');
    }, 1500);
  }
}

// ── Add terminal directly (no picker, for auto-start) ──
async function addTerminalDirect(cwd, runClaude = false) {
  if (panes.size >= MAX_PANES) return;

  const id = nextId++;
  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane';
  paneEl.dataset.id = id;

  const header = document.createElement('div');
  header.className = 'pane-header';

  const info = document.createElement('div');
  info.className = 'pane-info';

  const label = document.createElement('span');
  label.className = 'pane-number';
  label.textContent = id;

  const pathLabel = document.createElement('span');
  pathLabel.className = 'pane-path';
  pathLabel.textContent = '...';

  info.appendChild(label);
  info.appendChild(pathLabel);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.innerHTML = '&#215;';
  closeBtn.title = 'Close (`+W)';

  header.appendChild(info);
  header.appendChild(closeBtn);

  const container = document.createElement('div');
  container.className = 'terminal-container';

  paneEl.appendChild(header);
  paneEl.appendChild(container);
  grid.appendChild(paneEl);

  paneEl.addEventListener('mousedown', () => setActive(id));
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removePane(id);
  });

  panes.set(id, { terminal: null, fitAddon: null, element: paneEl, pathLabel });
  updateCount();
  renumberPanes();
  setActive(id);

  requestAnimationFrame(() => fitAll());
  initTerminalInPane(id, cwd, container, pathLabel, runClaude);
}

// ── Add terminal (Phase 1 — creates pane DOM, shows picker) ──
async function addTerminal() {
  if (panes.size >= MAX_PANES) return;

  const id = nextId++;

  const paneEl = document.createElement('div');
  paneEl.className = 'terminal-pane';
  paneEl.dataset.id = id;

  const header = document.createElement('div');
  header.className = 'pane-header';

  const info = document.createElement('div');
  info.className = 'pane-info';

  const label = document.createElement('span');
  label.className = 'pane-number';
  label.textContent = id;

  const pathLabel = document.createElement('span');
  pathLabel.className = 'pane-path';
  pathLabel.textContent = '...';

  info.appendChild(label);
  info.appendChild(pathLabel);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.innerHTML = '&#215;';
  closeBtn.title = 'Close (`+W)';

  header.appendChild(info);
  header.appendChild(closeBtn);

  const container = document.createElement('div');
  container.className = 'terminal-container';

  paneEl.appendChild(header);
  paneEl.appendChild(container);
  grid.appendChild(paneEl);

  // Click to focus
  paneEl.addEventListener('mousedown', () => setActive(id));

  // Close button
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removePane(id);
  });

  // Register pane with null terminal/fitAddon (picker phase)
  panes.set(id, { terminal: null, fitAddon: null, element: paneEl, pathLabel });
  updateCount();
  renumberPanes();
  setActive(id);

  requestAnimationFrame(() => fitAll());

  // Show directory picker
  showDirectoryPicker(id, container, pathLabel);
}

function removePane(id) {
  const pane = panes.get(id);
  if (!pane) return;

  const keysBefore = [...panes.keys()];
  const closedIndex = keysBefore.indexOf(id);

  window.pty.destroy(id);
  if (pane.terminal) pane.terminal.dispose();

  pane.element.remove();
  panes.delete(id);

  updateCount();
  renumberPanes();

  if (activeId === id) {
    const remaining = [...panes.keys()];
    if (remaining.length > 0) {
      const newIndex = Math.min(closedIndex, remaining.length - 1);
      setActive(remaining[newIndex]);
    } else {
      activeId = null;
    }
  }

  requestAnimationFrame(() => fitAll());
}

function fitAll() {
  for (const [id, pane] of panes) {
    if (!pane.fitAddon) continue;
    try {
      pane.fitAddon.fit();
      window.pty.resize(id, pane.terminal.cols, pane.terminal.rows);
    } catch (e) {
      // ignore fit errors during transitions
    }
  }
}

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('creampuff-theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  for (const [, pane] of panes) {
    if (pane.terminal) pane.terminal.options.theme = themes[theme];
  }
  window.themeBridge?.setNativeTheme(theme);
}

// PTY -> xterm
if (window.pty) {
  window.pty.onData((id, data) => {
    const pane = panes.get(id);
    if (pane && pane.terminal) {
      pane.terminal.write(data);
    }
  });

  window.pty.onExit((id, exitCode) => {
    removePane(id);
  });
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') {
    e.preventDefault();
    window.windowControl?.toggleFullscreen();
    setTimeout(fitAll, 200);
    return;
  }

  if (e.key === '`' && e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (activeId) {
      const pane = panes.get(activeId);
      if (pane && pane.terminal) window.pty.write(activeId, '`');
    }
    return;
  }

  if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    backtickHeld = true;
    if (backtickPending) return;
    backtickPending = true;
    clearTimeout(backtickTimer);
    backtickTimer = setTimeout(() => {
      if (!backtickHeld) backtickPending = false;
    }, 1000);
    return;
  }

  if (backtickPending) {
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
      return;
    }
    e.preventDefault();
    clearTimeout(backtickTimer);
    backtickPending = backtickHeld;

    if (e.key === 't' || e.key === 'T') {
      addTerminal();
      return;
    }
    if (e.key === 'w' || e.key === 'W') {
      if (activeId) removePane(activeId);
      return;
    }
    if (e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      const ids = [...panes.keys()];
      if (idx < ids.length) {
        setActive(ids[idx]);
      }
      return;
    }
    if (e.key === '0') {
      const ids = [...panes.keys()];
      if (9 < ids.length) {
        setActive(ids[9]);
      }
      return;
    }
    if (SHIFT_DIGIT_MAP[e.key] !== undefined) {
      const idx = SHIFT_DIGIT_MAP[e.key] - 1;
      const ids = [...panes.keys()];
      if (idx < ids.length) {
        setActive(ids[idx]);
      }
      return;
    }
    if (e.key === 'e' || e.key === 'E') {
      setTheme(currentTheme === 'dark' ? 'light' : 'dark');
      return;
    }
    backtickPending = false;
    return;
  }
});

// Track backtick release
document.addEventListener('keyup', (e) => {
  if (e.key === '`') {
    backtickHeld = false;
    clearTimeout(backtickTimer);
    backtickTimer = setTimeout(() => {
      backtickPending = false;
    }, 200);
  }
});

// Resize handler
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitAll, 100);
});

// Apply persisted theme before first terminal
setTheme(currentTheme);

// Restore fullscreen state
if (localStorage.getItem('creampuff-fullscreen') === 'true') {
  window.windowControl?.setFullscreen(true);
  setTimeout(fitAll, 300);
}

// Listen for fullscreen changes
window.windowControl?.onFullscreenChanged((isFullScreen) => {
  localStorage.setItem('creampuff-fullscreen', isFullScreen);
});

// Show server URL in toolbar
window.serverBridge?.onUrl(({ port, token }) => {
  const el = document.getElementById('server-url');
  if (el) el.textContent = `mobile: :${port}`;
});

// ── Tunnel / QR ──
const QRCode = require('qrcode');
const tunnelStatus = document.getElementById('tunnel-status');
const tunnelStopBtn = document.getElementById('tunnel-stop-btn');
const serverUrlWrapper = document.getElementById('server-url-wrapper');
const qrDropdown = document.getElementById('qr-dropdown');
const qrCanvas = document.getElementById('qr-canvas');
const qrUrlText = document.getElementById('qr-url');
const qrCopyBtn = document.getElementById('qr-copy');
let currentTunnelUrl = null;
let qrRendered = false;

function renderQr(url) {
  qrUrlText.textContent = url;
  QRCode.toCanvas(qrCanvas, url, { width: 180, margin: 2, color: { dark: '#09090b', light: '#ffffff' } });
  qrRendered = true;
}

// Show/hide QR dropdown on hover
serverUrlWrapper.addEventListener('mouseenter', () => {
  if (currentTunnelUrl) {
    if (!qrRendered) renderQr(currentTunnelUrl);
    qrDropdown.classList.remove('hidden');
  }
});

serverUrlWrapper.addEventListener('mouseleave', () => {
  qrDropdown.classList.add('hidden');
});

window.tunnelBridge?.onUrl((url) => {
  currentTunnelUrl = url;
  qrRendered = false;
  tunnelStatus.textContent = 'tunnel active';
  tunnelStopBtn.classList.remove('hidden');
});

window.tunnelBridge?.onStopped(() => {
  currentTunnelUrl = null;
  qrRendered = false;
  tunnelStatus.textContent = '';
  tunnelStopBtn.classList.add('hidden');
  qrDropdown.classList.add('hidden');
});

tunnelStopBtn.addEventListener('click', () => {
  window.tunnelBridge?.stop();
  tunnelStopBtn.classList.add('hidden');
  tunnelStatus.textContent = '';
  qrDropdown.classList.add('hidden');
});

qrCopyBtn.addEventListener('click', () => {
  if (currentTunnelUrl) navigator.clipboard.writeText(currentTunnelUrl);
});

// Start with one terminal — show directory picker
addTerminal();
