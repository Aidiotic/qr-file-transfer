const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 6798;
const SESSION_TTL_MS = 5 * 60 * 1000; // drop unpaired sessions after 5 minutes

const app = express();
app.use(express.static(`${__dirname}/public`));

// Serve index.html for both the host route (/) and the peer join route (/s/:id)
app.get('/s/:id', (req, res) => {
  res.sendFile(`${__dirname}/public/index.html`);
});

const server = http.createServer(app);

app.post('/api/session', express.json(), (req, res) => {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(8).toString('hex');
  sessions.set(id, { host: null, peer: null, token, createdAt: Date.now() });
  const lanIp = getLanIp();
  const joinUrl = `http://${lanIp}:${PORT}/s/${id}?t=${token}`;
  // QR generation moved to client to avoid blocking server on CPU
  res.json({ id, token, lanIp, port: PORT, joinUrl });
});

// session id -> { host: ws|null, peer: ws|null, token, createdAt }
const sessions = new Map();

const wss = new WebSocketServer({ server, path: '/ws' });

// Constant-time token check. Guards against timing side-channels; lengths are
// fixed (16 hex chars) so a mismatch just fails the comparison, never throws.
function tokenMatches(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session');
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  const session = sessions.get(sessionId);
  if (!session || (role !== 'host' && role !== 'peer') || !tokenMatches(session.token, token)) {
    ws.close(1008, 'invalid session or token');
    return;
  }

  // Only one connection per role, per session (single-use pairing).
  if (session[role]) {
    ws.close(1008, 'role already taken');
    return;
  }

  session[role] = ws;
  ws.role = role;
  ws.sessionId = sessionId;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const other = role === 'host' ? session.peer : session.host;
  if (other && other.readyState === ws.OPEN) {
    other.send(JSON.stringify({ type: 'peer-joined' }));
    ws.send(JSON.stringify({ type: 'peer-joined' }));
  }

  ws.on('message', (data) => {
    const s = sessions.get(ws.sessionId);
    if (!s) return;
    const target = ws.role === 'host' ? s.peer : s.host;
    if (target && target.readyState === ws.OPEN) {
      // Relay as text: signaling payloads are always JSON strings, but the
      // `ws` lib delivers incoming frames as Buffers, which would otherwise
      // be re-sent as binary frames and arrive as a Blob in the browser.
      target.send(data.toString());
    }
  });

  ws.on('close', () => {
    const s = sessions.get(ws.sessionId);
    if (!s) return;
    s[ws.role] = null;
    const other = ws.role === 'host' ? s.peer : s.host;
    if (other && other.readyState === ws.OPEN) {
      other.send(JSON.stringify({ type: 'peer-left' }));
    }
    if (ws.role === 'host' || !other) {
      // The host owns the session: when it goes away (or nobody is left), drop it.
      sessions.delete(ws.sessionId);
    }
    // If only the phone dropped (screen lock, backgrounded tab), the session
    // survives so the same QR can be re-scanned to reconnect.
  });
});

// Keep signaling sockets alive through idle timeouts, and reap dead ones so
// a stale entry can't hold a session's host/peer slot hostage. Also sweep
// sessions that were created (via /api/session) but never paired — e.g. a
// host tab that was opened and abandoned — so they don't leak forever.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (!s.host && !s.peer && now - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 25000);

function getLanIp() {
  // When hotspotting from an iPhone, the Mac gets a weird 192.0.0.2/32 IP
  // that the iPhone itself refuses to route to. Using the Bonjour mDNS
  // hostname works natively across Apple devices and bypasses this.
  const hostname = os.hostname().replace(/\.local$/, '');
  return `${hostname}.local`;
}

server.listen(PORT, () => {
  const ip = getLanIp();
  console.log(`QR File Transfer running.`);
  console.log(`Open this on your computer: http://${ip}:${PORT}`);
  console.log(`(Make sure your phone is on the same Wi-Fi network.)`);
});
