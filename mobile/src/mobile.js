const { AnsiUp } = require('ansi_up');

// ═══════════════════════════════════════
// State
// ═══════════════════════════════════════

let ws = null;
let panes = [];            // [{id, cwd}]
let activePane = null;
let reconnectDelay = 500;
let reconnectTimer = null;
let userScrolledUp = false;

// Per-pane output buffers (raw ANSI text)
const paneBuffers = new Map();  // id -> string

const MAX_BUFFER = 150000;      // trim to this when exceeded
// DOM
const statusDot    = document.getElementById('status-dot');
const paneSelect   = document.getElementById('pane-select');
const paneDots     = document.getElementById('pane-dots');
const clearBtn     = document.getElementById('clear-btn');
const output       = document.getElementById('output');
const scrollBtn    = document.getElementById('scroll-btn');
const interruptBtn = document.getElementById('interrupt-btn');
const modeToggle   = document.getElementById('mode-toggle');
const modeBtn      = document.getElementById('mode-btn');
const modeLabel    = document.getElementById('mode-label');
const inputEl      = document.getElementById('input');
const sendBtn      = document.getElementById('send');

// Track Claude session state per render
let isClaudeSession = false;
let currentMode = '';  // 'plan' or 'code'

// ═══════════════════════════════════════
// Pane Selector
// ═══════════════════════════════════════

function shortenPath(p) {
  if (!p) return '?';
  return p.replace(/\\/g, '/').replace(/^C:\/Users\/[^/]+/, '~');
}

function renderPaneSelect() {
  const prev = paneSelect.value;
  paneSelect.innerHTML = '';

  if (panes.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No sessions';
    opt.disabled = true;
    opt.selected = true;
    paneSelect.appendChild(opt);
    return;
  }

  panes.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${i + 1}: ${shortenPath(p.cwd)}`;
    paneSelect.appendChild(opt);
  });

  // Restore selection or auto-select
  if (prev && panes.find(p => p.id === prev)) {
    paneSelect.value = prev;
  } else if (panes.length > 0) {
    paneSelect.value = panes[0].id;
  }
}

paneSelect.addEventListener('change', () => {
  switchPane(paneSelect.value);
});

function switchPane(id) {
  if (activePane === id) return;

  // Unsubscribe old
  if (activePane != null && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'unsubscribe', id: activePane }));
  }

  activePane = id;
  paneSelect.value = id;
  renderPaneDots();

  // Render buffered output
  renderOutput();

  // Subscribe
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'subscribe', id }));
  }

  inputEl.focus();
}

// ═══════════════════════════════════════
// Output Rendering
// ═══════════════════════════════════════

const SEP_RE = /[─━═╌╍┈┉]{10,}/g;

function collapseSeparators(text) {
  return text.replace(SEP_RE, '<div class="sep"></div>');
}

// ── Mini terminal emulator ──
// Ink (Claude Code's TUI renderer) uses cursor movement, line erase, etc.
// ansi_up only handles SGR (colors) — it ignores cursor sequences, producing
// garbled text.  This function interprets the raw buffer into a 2D screen grid
// so we get correct character positions and ordering.
function renderTerminal(buf) {
  const rows = [];   // array of char arrays
  let r = 0, c = 0;

  function ensureRow(row) { while (rows.length <= row) rows.push([]); }
  function ensureCol(row, col) { ensureRow(row); while (rows[row].length <= col) rows[row].push(' '); }

  let dim = false;  // SGR 2 (dim/faint) tracking

  let i = 0;
  while (i < buf.length) {
    const ch = buf[i];

    if (ch === '\x1b' && buf[i + 1] === '[') {
      // CSI sequence
      i += 2;
      let params = '';
      while (i < buf.length && ((buf[i] >= '0' && buf[i] <= '9') || buf[i] === ';' || buf[i] === '?')) {
        params += buf[i++];
      }
      const cmd = buf[i++];
      const nums = params.replace(/^\?/, '').split(';').map(n => parseInt(n) || 0);

      switch (cmd) {
        case 'A': r = Math.max(0, r - (nums[0] || 1)); break;
        case 'B': r += (nums[0] || 1); break;
        case 'C': c += (nums[0] || 1); break;
        case 'D': c = Math.max(0, c - (nums[0] || 1)); break;
        case 'H': case 'f':
          r = (nums[0] || 1) - 1;
          c = (nums.length > 1 ? nums[1] || 1 : 1) - 1;
          break;
        case 'J':
          if (nums[0] === 0 || params === '') {
            // Erase from cursor to end of screen
            ensureRow(r);
            rows[r].splice(c);
            rows.splice(r + 1);
          } else if (nums[0] === 1) {
            // Erase from start to cursor
            for (let ri = 0; ri < r; ri++) rows[ri] = [];
            ensureRow(r); ensureCol(r, c);
            for (let ci = 0; ci <= c; ci++) rows[r][ci] = ' ';
          } else if (nums[0] === 2 || nums[0] === 3) {
            rows.length = 0; r = 0; c = 0;
          }
          break;
        case 'K':
          ensureRow(r);
          if (nums[0] === 0 || params === '') rows[r].splice(c);
          else if (nums[0] === 1) { ensureCol(r, c); for (let j = 0; j <= c; j++) rows[r][j] = ' '; }
          else if (nums[0] === 2) rows[r] = [];
          break;
        case 'm':
          if (nums[0] === 2) dim = true;
          else if (nums[0] === 0) dim = false;
          else if (nums[0] === 22) dim = false;
          break;
      }
    } else if (ch === '\x1b' && buf[i + 1] === ']') {
      // OSC sequence (window title, etc.) — skip until BEL or ST
      i += 2;
      while (i < buf.length && buf[i] !== '\x07' && !(buf[i] === '\x1b' && buf[i + 1] === '\\')) i++;
      if (i < buf.length && buf[i] === '\x07') i++;
      else if (i < buf.length - 1 && buf[i] === '\x1b') i += 2;
    } else if (ch === '\r') {
      c = 0; i++;
    } else if (ch === '\n') {
      r++; c = 0; i++;
    } else if (ch === '\t') {
      c = (Math.floor(c / 8) + 1) * 8; i++;
    } else if (ch.charCodeAt(0) >= 32) {
      ensureRow(r); ensureCol(r, c);
      rows[r][c] = ch;
      c++; i++;
    } else {
      i++; // skip other control chars
    }
  }

  return rows.map(row => row.join('').trimEnd()).join('\n');
}

// ── Claude Code output filter ──
// Operates on clean screen text from renderTerminal().
// Extracts ●-prefixed (response) and ❯-prefixed (prompt) blocks + continuations.
function filterClaudeText(text) {
  const lines = text.split('\n');
  const out = [];
  let capturing = false;
  for (const line of lines) {
    if (line.includes('●')) {
      capturing = true;
      out.push(line);
    } else if (/^> \S/.test(line)) {
      // User prompt: "> something" (not the empty input ">")
      capturing = true;
      out.push(line);
    } else if (capturing) {
      if (line.trim() === '' || /^\s{2,}/.test(line) || line.includes('⎿')) {
        out.push(line);
      } else {
        capturing = false;
      }
    }
  }
  return out.join('\n');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getBuffer(id) {
  if (!paneBuffers.has(id)) paneBuffers.set(id, '');
  return paneBuffers.get(id);
}

function appendBuffer(id, data) {
  let buf = getBuffer(id) + data;
  if (buf.length > MAX_BUFFER * 1.5) {
    buf = buf.slice(-MAX_BUFFER);
  }
  paneBuffers.set(id, buf);
}

function renderOutput() {
  if (activePane == null) {
    output.innerHTML = '<span style="color:var(--fg-muted)">No session selected</span>';
    return;
  }
  const buf = getBuffer(activePane);
  const screen = renderTerminal(buf);

  // Detect Claude session from rendered text (escape-free, reliable)
  isClaudeSession = screen.includes('Claude') || screen.includes('●');

  if (isClaudeSession) {
    const filtered = filterClaudeText(screen);
    const styledLines = escapeHtml(filtered).split('\n').map(line => {
      if (/^&gt; \S/.test(line)) return '<span class="claude-prompt">' + line + '</span>';
      return line;
    }).join('\n');
    output.innerHTML = '<b>ClaudeCode</b>\n' + collapseSeparators(styledLines);

    // Detect current mode from status bar
    if (screen.includes('bypass permissions')) {
      currentMode = 'bypass';
    } else if (screen.includes('accept edits')) {
      currentMode = 'edits';
    } else if (screen.includes('plan mode')) {
      currentMode = 'plan';
    } else {
      currentMode = 'default';
    }
    updateActionBar();
  } else {
    // Normal terminal: use ansi_up for colors
    const fresh = new AnsiUp();
    fresh.use_classes = false;
    output.innerHTML = collapseSeparators(fresh.ansi_to_html(buf));
    updateActionBar();
  }
  if (!userScrolledUp) scrollToBottom();
}

function appendOutput(data) {
  renderOutput();
}

// ═══════════════════════════════════════
// Pane Dots
// ═══════════════════════════════════════

function renderPaneDots() {
  paneDots.innerHTML = '';
  if (panes.length <= 1) return;

  panes.forEach(p => {
    const dot = document.createElement('button');
    dot.className = 'pane-dot' + (p.id === activePane ? ' active' : '');
    dot.addEventListener('click', () => switchPane(p.id));
    paneDots.appendChild(dot);
  });
}

// ═══════════════════════════════════════
// Swipe Navigation
// ═══════════════════════════════════════

let touchStartX = 0;
let touchStartY = 0;

output.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].clientX;
  touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

output.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;

  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    const idx = panes.findIndex(p => p.id === activePane);
    if (idx === -1) return;

    if (dx < 0 && idx < panes.length - 1) {
      switchPane(panes[idx + 1].id);
    } else if (dx > 0 && idx > 0) {
      switchPane(panes[idx - 1].id);
    }
  }
}, { passive: true });

// ═══════════════════════════════════════
// Scroll Handling
// ═══════════════════════════════════════

output.addEventListener('scroll', () => {
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 60;
  userScrolledUp = !atBottom;
  scrollBtn.classList.toggle('hidden', atBottom);
});

scrollBtn.addEventListener('click', () => {
  scrollToBottom();
  userScrolledUp = false;
  scrollBtn.classList.add('hidden');
});

function scrollToBottom() {
  output.scrollTop = output.scrollHeight;
}

// ═══════════════════════════════════════
// Input
// ═══════════════════════════════════════

function sendInput(data) {
  if (ws && ws.readyState === 1 && activePane != null) {
    ws.send(JSON.stringify({ type: 'input', id: activePane, data }));
  }
}

function sendCommand() {
  const text = inputEl.value;
  // Send text + Enter, or just Enter if empty
  sendInput(text + '\r');
  inputEl.value = '';
  inputEl.focus();
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendCommand();
  }
});

sendBtn.addEventListener('click', sendCommand);

// Action bar
function updateActionBar() {
  // Interrupt button label
  interruptBtn.textContent = isClaudeSession ? 'Interrupt' : 'Ctrl+C';

  // Mode toggle: only visible in Claude sessions
  modeToggle.classList.toggle('hidden', !isClaudeSession);
  if (isClaudeSession) {
    const labels = { bypass: 'dangerously skip permissions', edits: 'code', plan: 'plan', default: 'suggest' };
    modeLabel.textContent = labels[currentMode] || 'suggest';
    modeBtn.className = 'mode-' + currentMode;
  }
}

interruptBtn.addEventListener('click', () => {
  if (isClaudeSession) {
    sendInput('\x1b');  // Escape — soft interrupt
  } else {
    sendInput('\x03');  // Ctrl+C
  }
  inputEl.focus();
});

modeBtn.addEventListener('click', () => {
  sendInput('\x1b[Z');  // Shift+Tab — cycle mode
  inputEl.focus();
});

// Clear output
clearBtn.addEventListener('click', () => {
  if (activePane != null) {
    paneBuffers.set(activePane, '');
    output.innerHTML = '';
  }
});

// ═══════════════════════════════════════
// WebSocket
// ═══════════════════════════════════════

const STORAGE_KEY = 'creampuff-auth-token';
let urlToken = new URLSearchParams(location.search).get('token');

if (urlToken) {
  localStorage.setItem(STORAGE_KEY, urlToken);
} else {
  urlToken = localStorage.getItem(STORAGE_KEY);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenParam = urlToken ? `?token=${urlToken}` : '';
  ws = new WebSocket(`${proto}//${location.host}/ws${tokenParam}`);

  statusDot.className = '';

  ws.onopen = () => {
    statusDot.className = 'ok';
    reconnectDelay = 500;
    ws.send(JSON.stringify({ type: 'list' }));
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'panes') {
      panes = msg.list;
      renderPaneSelect();
      renderPaneDots();

      // Auto-select first pane if none active
      if (panes.length > 0 && (activePane == null || !panes.find(p => p.id === activePane))) {
        switchPane(panes[0].id);
      } else if (panes.length === 0) {
        activePane = null;
        renderOutput();
      }
    } else if (msg.type === 'data') {
      appendBuffer(msg.id, msg.data);

      if (msg.id === activePane) {
        appendOutput(msg.data);
      }
    } else if (msg.type === 'created') {
      panes.push({ id: msg.id, cwd: msg.cwd });
      renderPaneSelect();
      renderPaneDots();

      // Auto-select if it's the only pane
      if (panes.length === 1) {
        switchPane(msg.id);
      }
    } else if (msg.type === 'closed') {
      const idx = panes.findIndex(p => p.id === msg.id);
      if (idx !== -1) panes.splice(idx, 1);
      paneBuffers.delete(msg.id);
      renderPaneSelect();
      renderPaneDots();

      if (msg.id === activePane) {
        if (panes.length > 0) {
          switchPane(panes[Math.min(idx, panes.length - 1)].id);
        } else {
          activePane = null;
          renderOutput();
        }
      }
    }
  };

  ws.onclose = () => {
    statusDot.className = 'err';
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
