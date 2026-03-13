const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const MAX_PANES = 6;
const panes = new Map();
let activeId = null;
let nextId = 1;
let currentTheme = 'dark';
let backtickPending = false;
let backtickTimer = null;
let backtickHeld = false;

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

function updateCount() {
  countDisplay.textContent = `${panes.size} / ${MAX_PANES}`;
  grid.setAttribute('data-count', panes.size);
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
    pane.terminal.focus();
  }
}

function shortenPath(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/^C:\/Users\/[^/]+/, '~');
}

async function addTerminal() {
  if (panes.size >= MAX_PANES) return;

  const id = nextId++;

  // Create DOM
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
  closeBtn.title = 'Close (Ctrl+Shift+W)';

  header.appendChild(info);
  header.appendChild(closeBtn);

  const container = document.createElement('div');
  container.className = 'terminal-container';

  paneEl.appendChild(header);
  paneEl.appendChild(container);
  grid.appendChild(paneEl);

  // Create xterm
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

  // Right-click context menu: copy selection or paste
  container.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const selection = terminal.getSelection();
    if (selection) {
      await window.clipboardBridge.write(selection);
      terminal.clearSelection();
    } else {
      const text = await window.clipboardBridge.read();
      if (text) {
        window.pty.write(id, text);
      }
    }
  });

  // Copy/paste key handlers
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    // Ctrl+Shift+C / Ctrl+Shift+V (classic terminal shortcuts)
    if (e.ctrlKey && e.shiftKey) {
      if (e.key === 'C') {
        const sel = terminal.getSelection();
        if (sel) window.clipboardBridge.write(sel);
        return false;
      }
      if (e.key === 'V') {
        window.clipboardBridge.read().then((text) => {
          if (text) window.pty.write(id, text);
        });
        return false;
      }
    }

    // Ctrl+C: copy if selection exists, otherwise let terminal handle (SIGINT)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'c') {
      const sel = terminal.getSelection();
      if (sel) {
        window.clipboardBridge.write(sel);
        terminal.clearSelection();
        return false;
      }
    }

    // Ctrl+V: always paste
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'v') {
      window.clipboardBridge.read().then((text) => {
        if (text) window.pty.write(id, text);
      });
      return false;
    }

    // Intercept backtick in all forms for chord system
    if (e.key === '`') {
      return false; // document keydown handles bare and Ctrl+backtick
    }

    // While backtick chord is pending, intercept second keys so xterm doesn't process them
    if (backtickPending) {
      const k = e.key.toLowerCase();
      if (k === 't' || k === 'w' || k === 'e' || (e.key >= '1' && e.key <= '6')) {
        return false; // document keydown handles the chord
      }
    }

    return true;
  });

  // Small delay to let DOM settle before fitting
  await new Promise((r) => setTimeout(r, 50));
  fitAddon.fit();

  const cols = terminal.cols;
  const rows = terminal.rows;

  // Create PTY
  const result = await window.pty.create(id, cols, rows);
  if (result.cwd) {
    pathLabel.textContent = shortenPath(result.cwd);
  }

  // xterm -> pty
  terminal.onData((data) => {
    window.pty.write(id, data);
  });

  // Click to focus
  paneEl.addEventListener('mousedown', () => setActive(id));

  // Close button
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTerminal(id);
  });

  panes.set(id, { terminal, fitAddon, element: paneEl, pathLabel });
  updateCount();
  renumberPanes();
  setActive(id);

  // Refit all terminals after grid reflow
  requestAnimationFrame(() => fitAll());

  // Auto-run claude code after shell initializes
  setTimeout(() => {
    window.pty.write(id, 'claude\r');
  }, 1500);
}

function removeTerminal(id) {
  const pane = panes.get(id);
  if (!pane) return;

  window.pty.destroy(id);
  pane.terminal.dispose();
  pane.element.remove();
  panes.delete(id);

  updateCount();
  renumberPanes();

  if (activeId === id) {
    const remaining = [...panes.keys()];
    if (remaining.length > 0) {
      setActive(remaining[remaining.length - 1]);
    } else {
      activeId = null;
    }
  }

  requestAnimationFrame(() => fitAll());
}

function fitAll() {
  for (const [id, pane] of panes) {
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
  document.documentElement.setAttribute('data-theme', theme);
  for (const [, pane] of panes) {
    pane.terminal.options.theme = themes[theme];
  }
  window.themeBridge.setNativeTheme(theme);
}

// PTY -> xterm
window.pty.onData((id, data) => {
  const pane = panes.get(id);
  if (pane) {
    pane.terminal.write(data);

    if (!pane._cwdUpdatePending) {
      pane._cwdUpdatePending = true;
      setTimeout(async () => {
        pane._cwdUpdatePending = false;
        const cwd = await window.pty.getCwd(id);
        if (cwd && pane.pathLabel) {
          pane.pathLabel.textContent = shortenPath(cwd) || cwd;
        }
      }, 2000);
    }
  }
});

window.pty.onExit((id, exitCode) => {
  removeTerminal(id);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl+backtick: send literal backtick to active terminal
  if (e.key === '`' && e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    if (activeId) window.pty.write(activeId, '`');
    return;
  }

  // Bare backtick: enter pending state (prefix key)
  if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    backtickHeld = true;
    if (backtickPending) return; // already pending, ignore repeat
    backtickPending = true;
    clearTimeout(backtickTimer);
    backtickTimer = setTimeout(() => {
      if (!backtickHeld) backtickPending = false; // timeout only if released
    }, 1000);
    return;
  }

  // While backtick is pending, handle second key
  if (backtickPending) {
    e.preventDefault();
    clearTimeout(backtickTimer);
    // Stay pending if backtick is still held, otherwise clear
    backtickPending = backtickHeld;

    if (e.key === 't' || e.key === 'T') {
      addTerminal();
      return;
    }
    if (e.key === 'w' || e.key === 'W') {
      if (activeId) removeTerminal(activeId);
      return;
    }
    if (e.key >= '1' && e.key <= '6') {
      const idx = parseInt(e.key) - 1;
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
    // Any other key: cancel pending, do nothing
    backtickPending = false;
    return;
  }
});

// Track backtick release
document.addEventListener('keyup', (e) => {
  if (e.key === '`') {
    backtickHeld = false;
    // Give a short grace period after release, then clear pending
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

// Start with one terminal
addTerminal();
