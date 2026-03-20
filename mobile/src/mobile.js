const { AnsiUp } = require('ansi_up');

const SHORTCUT_KEYS = {
  'ctrl-c': '\x03',
  'tab':    '\t',
  'up':     '\x1b[A',
  'down':   '\x1b[B',
  'esc':    '\x1b',
};

let currentTheme = localStorage.getItem('creampuff-mobile-theme') || 'dark';

let ws = null;
let panes = []; // [{id, cwd}]
let activePane = null;
let ansiUp = new AnsiUp();
let reconnectDelay = 500;
let reconnectTimer = null;

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statusStrip = document.getElementById('status-strip');
const outputView = document.getElementById('output-view');
const output = document.getElementById('output');
const panePath = document.getElementById('pane-path');
const paneDots = document.getElementById('pane-dots');

const cmdInput = document.getElementById('cmd-input');
const sendBtn = document.getElementById('send-btn');

function appendOutput(data) {
  const html = ansiUp.ansi_to_html(data);
  output.insertAdjacentHTML('beforeend', html);
  // Trim DOM if too large
  while (output.childNodes.length > 10000) {
    output.removeChild(output.firstChild);
  }
  // Auto-scroll to bottom
  outputView.scrollTop = outputView.scrollHeight;
}

function clearOutput() {
  output.innerHTML = '';
  ansiUp = new AnsiUp();
}

function sendInput(data) {
  if (ws && ws.readyState === 1 && activePane != null) {
    ws.send(JSON.stringify({ type: 'input', id: activePane, data }));
  }
}

function sendCommand() {
  const text = cmdInput.value;
  if (text === '' && document.activeElement === cmdInput) {
    // Empty enter = just send newline (confirm prompt, etc.)
    sendInput('\r');
    return;
  }
  sendInput(text + '\r');
  cmdInput.value = '';
  cmdInput.focus();
}

cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendCommand();
  }
});

sendBtn.addEventListener('click', sendCommand);

// Shortcut key buttons (Ctrl+C, Tab, arrows, Esc)
document.querySelectorAll('.sk[data-key]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = SHORTCUT_KEYS[btn.dataset.key];
    if (key) sendInput(key);
    cmdInput.focus();
  });
});

// Apply initial theme
document.documentElement.setAttribute('data-theme', currentTheme);

function setMobileTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('creampuff-mobile-theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
}

// Theme toggle
document.getElementById('theme-btn').addEventListener('click', () => {
  setMobileTheme(currentTheme === 'dark' ? 'light' : 'dark');
  cmdInput.focus();
});

// Swipe gesture handler
let touchStartX = 0;
let touchStartY = 0;
let swiping = false;

outputView.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  swiping = false;
}, { passive: true });

outputView.addEventListener('touchmove', (e) => {
  if (e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - touchStartX;
  const dy = e.touches[0].clientY - touchStartY;

  if (!swiping && Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy)) {
    swiping = true;
  }

  if (swiping) {
    outputView.classList.toggle('swipe-left', dx < -20);
    outputView.classList.toggle('swipe-right', dx > 20);
  }
}, { passive: true });

outputView.addEventListener('touchend', (e) => {
  outputView.classList.remove('swipe-left', 'swipe-right');

  if (!swiping) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;

  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
    const currentIdx = panes.findIndex(p => p.id === activePane);
    if (currentIdx === -1) return;

    if (dx < 0 && currentIdx < panes.length - 1) {
      switchPane(panes[currentIdx + 1].id);
    } else if (dx > 0 && currentIdx > 0) {
      switchPane(panes[currentIdx - 1].id);
    }
  }
  swiping = false;
}, { passive: true });

function shortenPath(p) {
  if (!p) return '?';
  return p.replace(/\\/g, '/').replace(/^C:\/Users\/[^/]+/, '~');
}

function renderPaneIndicator() {
  const active = panes.find(p => p.id === activePane);
  panePath.textContent = active ? shortenPath(active.cwd) : '';

  paneDots.innerHTML = '';
  for (const p of panes) {
    const dot = document.createElement('div');
    dot.className = 'pane-dot' + (p.id === activePane ? ' active' : '');
    dot.addEventListener('click', () => switchPane(p.id));
    paneDots.appendChild(dot);
  }

  statusText.textContent = panes.length + ' pane' + (panes.length !== 1 ? 's' : '');
}

function switchPane(id) {
  if (activePane === id) return;

  // Unsubscribe old
  if (activePane != null && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'unsubscribe', id: activePane }));
  }

  activePane = id;
  clearOutput();
  renderPaneIndicator();

  // Subscribe new (no resize — mobile doesn't affect desktop PTY)
  if (ws && ws.readyState === 1 && id != null) {
    ws.send(JSON.stringify({ type: 'subscribe', id }));
  }
}

const urlToken = new URLSearchParams(location.search).get('token');

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenParam = urlToken ? `?token=${urlToken}` : '';
  ws = new WebSocket(`${proto}//${location.host}/ws${tokenParam}`);

  statusDot.className = 'connecting';
  statusText.textContent = 'connecting...';

  ws.onopen = () => {
    statusDot.className = 'connected';
    reconnectDelay = 500;
    ws.send(JSON.stringify({ type: 'list' }));
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'panes') {
      panes = msg.list;
      renderPaneIndicator();
      if (panes.length > 0 && (activePane == null || !panes.find(p => p.id === activePane))) {
        switchPane(panes[0].id);
      } else if (panes.length === 0) {
        activePane = null;
        clearOutput();
        renderPaneIndicator();
      }
    } else if (msg.type === 'data') {
      if (msg.id === activePane) {
        appendOutput(msg.data);
      }
    } else if (msg.type === 'created') {
      panes.push({ id: msg.id, cwd: msg.cwd });
      renderPaneIndicator();
      if (panes.length === 1) {
        switchPane(msg.id);
      }
    } else if (msg.type === 'closed') {
      const idx = panes.findIndex(p => p.id === msg.id);
      if (idx !== -1) panes.splice(idx, 1);
      if (msg.id === activePane) {
        if (panes.length > 0) {
          const newIdx = Math.min(idx, panes.length - 1);
          switchPane(panes[newIdx].id);
        } else {
          activePane = null;
          clearOutput();
        }
      }
      renderPaneIndicator();
    }
  };

  ws.onclose = () => {
    statusDot.className = 'disconnected';
    statusText.textContent = 'disconnected';
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    connect();
  }, reconnectDelay);
}

connect();
