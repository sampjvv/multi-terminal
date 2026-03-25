const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const BUFFER_LIMIT = 100 * 1024; // 100KB per pane
const paneMeta = new Map(); // id -> { cwd, buffer }
let httpServer = null;
let wss = null;
let writeCallback = null;
let resizeCallback = null;
let authToken = null;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

function requestHandler(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const url = parsed.pathname;

  // Auth check for root/index
  if (url === '/' || url === '/index.html') {
    if (parsed.searchParams.get('token') !== authToken) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  }

  // Map URL to mobile/ directory
  let relPath = url === '/' ? '/index.html' : url;
  // Prevent directory traversal
  const normalized = path.normalize(relPath).replace(/\\/g, '/');
  if (normalized.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const filePath = path.join(__dirname, 'mobile', normalized);

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

function setupWss() {
  wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    ws._subscriptions = new Set();

    ws.send(JSON.stringify({
      type: 'panes',
      list: [...paneMeta.entries()].map(([id, m]) => ({ id, cwd: m.cwd })),
    }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'list') {
        ws.send(JSON.stringify({
          type: 'panes',
          list: [...paneMeta.entries()].map(([id, m]) => ({ id, cwd: m.cwd })),
        }));
      } else if (msg.type === 'subscribe') {
        ws._subscriptions.add(msg.id);
        const meta = paneMeta.get(msg.id);
        if (meta && meta.buffer.length > 0) {
          ws.send(JSON.stringify({ type: 'data', id: msg.id, data: meta.buffer }));
        }
      } else if (msg.type === 'unsubscribe') {
        ws._subscriptions.delete(msg.id);
      } else if (msg.type === 'resize') {
        if (resizeCallback && msg.id != null && msg.cols && msg.rows) {
          resizeCallback(msg.id, msg.cols, msg.rows);
        }
      } else if (msg.type === 'input') {
        if (writeCallback && msg.id != null && msg.data) {
          writeCallback(msg.id, msg.data);
        }
      }
    });

    ws.on('close', () => {
      ws._subscriptions.clear();
    });
  });
}

function createServer() {
  httpServer = http.createServer(requestHandler);
  setupWss();

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== authToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
}

async function start(port, onWrite, onResize, persistentKey) {
  writeCallback = onWrite;
  resizeCallback = onResize;
  authToken = persistentKey || crypto.randomBytes(32).toString('hex');

  for (let p = port; p < port + 11; p++) {
    createServer();
    try {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(p, '0.0.0.0', () => {
          httpServer.removeAllListeners('error');
          resolve();
        });
      });
      return { port: httpServer.address().port, token: authToken };
    } catch (err) {
      if (err.code === 'EADDRINUSE' && p < port + 10) {
        httpServer.close();
        continue;
      }
      throw err;
    }
  }
}

function stop() {
  if (wss) {
    for (const ws of wss.clients) ws.close();
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

function onPaneCreated(id, cwd) {
  paneMeta.set(id, { cwd, buffer: '' });
  broadcast({ type: 'created', id, cwd });
}

function onPaneData(id, data) {
  const meta = paneMeta.get(id);
  if (meta) {
    meta.buffer += data;
    if (meta.buffer.length > BUFFER_LIMIT) {
      meta.buffer = meta.buffer.slice(-BUFFER_LIMIT);
    }
  }
  if (!wss) return;
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && ws._subscriptions && ws._subscriptions.has(id)) {
      ws.send(JSON.stringify({ type: 'data', id, data }));
    }
  }
}

function onPaneExited(id) {
  paneMeta.delete(id);
  broadcast({ type: 'closed', id });
}

function broadcast(msg) {
  if (!wss) return;
  const str = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

module.exports = { start, stop, onPaneCreated, onPaneData, onPaneExited };
