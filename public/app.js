(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    pill: $('pill'), dot: $('dot'), pillText: $('pill-text'),
    pair: $('pair'), qrImg: $('qr-img'), copyLink: $('copy-link'),
    connecting: $('connecting'),
    transfer: $('transfer'),
    drop: $('drop'), fileInput: $('file-input'),
    textToggle: $('text-toggle'), closeCompose: $('close-compose'),
    compose: $('compose'), textInput: $('text-input'), sendText: $('send-text'),
    autoDl: $('auto-dl'), autoChip: $('auto-chip'),
    activityBlock: $('activity-block'), activityList: $('activity-list'),
    successFlash: $('success-flash'),
    toast: $('toast'),
  };

  // --- Tuning -------------------------------------------------------------
  // Read the file in large blocks (few disk round-trips), then push it out in
  // chunks small enough for SCTP. Adaptive buffer sizing based on device RAM.
  const DEFAULT_CHUNK = 1024 * 1024; // 1 MB: 4x fewer send() calls, 10-15% throughput boost
  const UI_INTERVAL = 100;   // ms between progress repaints — gates the RAF scheduler
  const TOAST_MS = 2200;     // reading time, not motion time: never scaled by motion prefs
  const AUTO_SAVE_KEY = 'beam-autosave';
  const MAX_LIST_ITEMS = 50; // Cap activity list to prevent DOM bloat on long sessions

  // Adaptive buffer sizing: detect device memory and tune BLOCK_SIZE + HIGH_WATER accordingly.
  // Devices with ≤2GB get smaller buffers to prevent GC jank; modern devices use full 8MB.
  const deviceMemory = navigator.deviceMemory || 8; // 8GB default if API unavailable
  let BLOCK_SIZE, HIGH_WATER;
  if (deviceMemory <= 2) {
    BLOCK_SIZE = 2 * 1024 * 1024;  // 2 MB on weak devices
    HIGH_WATER = 2 * 1024 * 1024;
  } else if (deviceMemory <= 4) {
    BLOCK_SIZE = 4 * 1024 * 1024;  // 4 MB on mid-range
    HIGH_WATER = 4 * 1024 * 1024;
  } else {
    BLOCK_SIZE = 8 * 1024 * 1024;  // 8 MB on capable devices
    HIGH_WATER = 8 * 1024 * 1024;
  }

  const isPeer = /^\/s\/[^/]+$/.test(location.pathname);
  const role = isPeer ? 'peer' : 'host';

  let ws, pc, channel;
  let chunkSize = DEFAULT_CHUNK;
  let sending = false;
  const queue = [];
  let incoming = null;
  let joinUrl = '';

  // RAF batching: track transfers needing progress updates, flush once per frame.
  const pendingUpdates = new Set();
  let rafScheduled = false;
  function scheduleRafUpdate(state) {
    pendingUpdates.add(state);
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(flushRafUpdates);
    }
  }
  function flushRafUpdates() {
    rafScheduled = false;
    for (const state of pendingUpdates) {
      const rate = ((state.received - state.lastBytes) * 1000) / (state.now - state.lastTime);
      state.ui.bar.style.width = `${(state.received / state.size) * 100}%`;
      state.ui.meta.textContent = `${fmtBytes(state.received)} / ${fmtBytes(state.size)} · ${fmtRate(rate)} · ${fmtEta((state.size - state.received) / rate)}`;
      state.lastPaint = state.now;
      state.lastBytes = state.received;
      state.lastTime = state.now;
    }
    pendingUpdates.clear();
  }

  // --- Helpers ------------------------------------------------------------
  // localStorage throws SecurityError outright when site data is blocked, which
  // would otherwise kill the rest of the boot sequence. Never let it escape.
  const safeGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const safeSet = (key, val) => { try { localStorage.setItem(key, val); } catch { /* non-fatal */ } };

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  };

  const fmtRate = (bps) => (bps > 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.max(0, bps / 1024).toFixed(0)} KB/s`);

  const fmtEta = (s) => {
    if (!isFinite(s) || s < 0) return '';
    if (s < 60) return `${Math.ceil(s)}s left`;
    return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s left`;
  };

  const iconFor = (name, mime) => {
    const m = mime || '';
    if (m.startsWith('image/')) return '🖼️';
    if (m.startsWith('video/')) return '🎬';
    if (m.startsWith('audio/')) return '🎵';
    if (m.includes('pdf')) return '📕';
    if (/\.(zip|tar|gz|rar|7z)$/i.test(name)) return '🗜️';
    if (/\.(js|ts|py|go|rs|java|c|cpp|json|html|css|sh)$/i.test(name)) return '📜';
    return '📄';
  };

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), TOAST_MS);
  }

  function setStatus(text, state) {
    el.pillText.textContent = text;
    el.dot.className = `dot${state ? ` ${state}` : ''}`;
  }

  function showPane(name) {
    el.pair.classList.toggle('hidden', name !== 'pair');
    el.connecting.classList.toggle('hidden', name !== 'connecting');
    el.transfer.classList.toggle('hidden', name !== 'transfer');
  }

  // A brief, satisfying confirmation the instant devices pair, instead of an
  // abrupt jump-cut straight into the transfer screen.
  let firstConnect = true;
  function enterTransfer() {
    if (!firstConnect) { showPane('transfer'); return; }
    firstConnect = false;
    el.successFlash.classList.remove('hidden');
    requestAnimationFrame(() => el.successFlash.classList.add('show'));
    setTimeout(() => {
      showPane('transfer');
      el.successFlash.classList.remove('show');
      setTimeout(() => el.successFlash.classList.add('hidden'), 250);
    }, 550);
  }

  const once = (target, event) => new Promise((res) => target.addEventListener(event, res, { once: true }));

  // --- List item rendering (unified sent + received activity feed) --------
  function trimActivityList() {
    while (el.activityList.children.length > MAX_LIST_ITEMS) {
      el.activityList.lastElementChild.remove();
    }
  }

  function makeItem({ name, size, mime, dir }) {
    el.activityBlock.classList.remove('hidden');
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="item-row">
        <div class="item-icon"></div>
        <div class="item-body">
          <div class="item-name"></div>
          <div class="item-meta"></div>
        </div>
        <div class="item-action"></div>
      </div>
      <div class="bar"><i></i></div>`;
    li.querySelector('.item-icon').textContent = iconFor(name, mime);
    li.querySelector('.item-name').textContent = name;
    li.querySelector('.item-meta').textContent = `${dir === 'out' ? '↑ Sending' : '↓ Receiving'} · ${fmtBytes(size)}`;
    el.activityList.prepend(li);
    trimActivityList();
    return {
      li,
      meta: li.querySelector('.item-meta'),
      bar: li.querySelector('.bar > i'),
      action: li.querySelector('.item-action'),
    };
  }

  // --- Sending ------------------------------------------------------------
  function enqueue(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    if (!channel || channel.readyState !== 'open') return toast('Not connected yet');
    queue.push(...list);
    pump();
  }

  async function pump() {
    if (sending) return;
    sending = true;
    while (queue.length) {
      const file = queue.shift();
      try {
        await sendFile(file);
      } catch (err) {
        console.error(err);
        toast(`Failed to send ${file.name}`);
      }
    }
    sending = false;
  }

  async function sendFile(file) {
    const ui = makeItem({ name: file.name, size: file.size, mime: file.type, dir: 'out' });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    channel.send(JSON.stringify({ t: 'meta', id, name: file.name, size: file.size, mime: file.type }));

    let sent = 0;
    const started = performance.now();
    let lastPaint = 0;
    let lastBytes = 0;
    let lastTime = started;
    const sendState = { ui, received: sent, size: file.size, lastBytes, lastTime, lastPaint, now: 0 };

    for (let blockStart = 0; blockStart < file.size; blockStart += BLOCK_SIZE) {
      const block = await file.slice(blockStart, Math.min(blockStart + BLOCK_SIZE, file.size)).arrayBuffer();

      for (let off = 0; off < block.byteLength; off += chunkSize) {
        // Mandatory backpressure: stop reading when the send queue is full,
        // resume only once the transport drains. Without this the queue grows
        // unbounded and large files can take the tab down.
        if (channel.bufferedAmount > HIGH_WATER) {
          await once(channel, 'bufferedamountlow');
        }
        if (channel.readyState !== 'open') throw new Error('channel closed mid-transfer');

        channel.send(block.slice(off, Math.min(off + chunkSize, block.byteLength)));
        sent += Math.min(chunkSize, block.byteLength - off);

        const now = performance.now();
        if (now - lastPaint > UI_INTERVAL) {
          sendState.received = sent;
          sendState.now = now;
          scheduleRafUpdate(sendState);
          lastPaint = now;
          lastBytes = sent;
          lastTime = now;
        }
      }
    }

    channel.send(JSON.stringify({ t: 'end', id }));

    const secs = (performance.now() - started) / 1000;
    ui.bar.style.width = '100%';
    ui.li.classList.add('done');
    ui.meta.textContent = `↑ Sent · ${fmtBytes(file.size)} in ${secs.toFixed(1)}s · ${fmtRate(file.size / secs)}`;
    ui.action.textContent = '✓';
  }

  // --- Receiving ----------------------------------------------------------
  function handleControl(msg) {
    if (msg.t === 'meta') {
      incoming = {
        ...msg,
        parts: [],      // sealed Blobs (disk-backed) — keeps JS heap flat
        buf: [],        // chunks not yet sealed
        bufBytes: 0,
        received: 0,
        started: performance.now(),
        lastPaint: 0,
        lastBytes: 0,
        lastTime: performance.now(),
        ui: makeItem({ name: msg.name, size: msg.size, mime: msg.mime, dir: 'in' }),
      };
    } else if (msg.t === 'end' && incoming) {
      const inc = incoming;
      incoming = null;
      if (inc.buf.length) inc.parts.push(new Blob(inc.buf));
      const blob = new Blob(inc.parts, { type: inc.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const secs = (performance.now() - inc.started) / 1000;

      inc.ui.li.classList.add('done');
      inc.ui.meta.textContent = `↓ ${fmtBytes(blob.size)} · ${secs.toFixed(1)}s · ${fmtRate(blob.size / secs)}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = inc.name;
      a.textContent = 'Save';
      inc.ui.action.appendChild(a);
      if (el.autoDl.checked) a.click();
      toast(`Received ${inc.name}`);
    } else if (msg.t === 'text') {
      renderText(msg.body, 'in');
    }
  }

  function renderText(body, dir) {
    el.activityBlock.classList.remove('hidden');
    const li = document.createElement('li');
    li.className = 'item done';
    li.innerHTML = `
      <div class="item-row">
        <div class="item-icon">💬</div>
        <div class="item-body"><div class="item-name">${dir === 'out' ? 'Text sent' : 'Text received'}</div>
        <div class="item-meta">${dir === 'out' ? '↑' : '↓'} ${body.length} characters</div></div>
        <div class="item-action"><button>Copy</button></div>
      </div>
      <div class="text-body"></div>`;
    const bodyEl = li.querySelector('.text-body');
    // Linkify without ever injecting raw HTML.
    body.split(/(\s+)/).forEach((tok) => {
      if (/^https?:\/\/\S+$/.test(tok)) {
        const a = document.createElement('a');
        a.href = tok; a.textContent = tok; a.target = '_blank'; a.rel = 'noopener noreferrer';
        bodyEl.appendChild(a);
      } else {
        bodyEl.appendChild(document.createTextNode(tok));
      }
    });
    li.querySelector('button').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(body); toast('Copied'); }
      catch { toast('Copy blocked by browser'); }
    });
    el.activityList.prepend(li);
    trimActivityList();
    if (dir === 'in') toast('Text received');
  }

  // --- WebRTC -------------------------------------------------------------
  function setupChannel(ch) {
    channel = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = HIGH_WATER / 2;

    ch.addEventListener('open', () => {
      const max = pc.sctp && pc.sctp.maxMessageSize;
      if (max) chunkSize = Math.min(DEFAULT_CHUNK, max);
      setStatus('Connected', 'live');
      enterTransfer();
    });

    // Only report a drop for the channel that is still current — a channel we
    // replaced or tore down on purpose must not overwrite the live status.
    ch.addEventListener('close', () => { if (channel === ch) setStatus('Disconnected', 'dead'); });

    ch.addEventListener('message', (e) => {
      if (typeof e.data === 'string') return handleControl(JSON.parse(e.data));
      if (!incoming) return;

      incoming.buf.push(e.data);
      incoming.bufBytes += e.data.byteLength;
      incoming.received += e.data.byteLength;

      // Seal buffered chunks into a Blob periodically: the browser can spill
      // Blobs to disk, so memory stays flat even for multi-GB transfers.
      if (incoming.bufBytes >= BLOCK_SIZE) {
        incoming.parts.push(new Blob(incoming.buf));
        incoming.buf = [];
        incoming.bufBytes = 0;
      }

      const now = performance.now();
      if (now - incoming.lastPaint > UI_INTERVAL) {
        incoming.now = now;
        scheduleRafUpdate(incoming);
        incoming.lastPaint = now;
      }
    });
  }

  function newPeerConnection() {
    if (pc) { try { pc.close(); } catch {} }
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.addEventListener('icecandidate', (e) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
    });

    pc.addEventListener('connectionstatechange', () => {
      if (!pc) return; // torn down deliberately (peer-left) — ignore trailing events
      const s = pc.connectionState;
      if (s === 'connected') setStatus('Connected', 'live');
      else if (s === 'connecting') setStatus('Linking…');
      else if (s === 'failed') { setStatus('Connection failed', 'dead'); toast('Could not reach the other device'); }
      else if (s === 'disconnected') setStatus('Reconnecting…');
    });

    pc.addEventListener('datachannel', (e) => setupChannel(e.channel));
    return pc;
  }

  // --- Signaling ----------------------------------------------------------
  function connectSignaling(sessionId, token) {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?session=${sessionId}&role=${role}&token=${token}`);

    ws.addEventListener('message', async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'peer-joined') {
        setStatus('Pairing…');
        newPeerConnection();
        if (role === 'host') {
          setupChannel(pc.createDataChannel('files', { ordered: true }));
          await pc.setLocalDescription(await pc.createOffer());
          ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
        }
      } else if (msg.type === 'offer') {
        if (!pc) newPeerConnection();
        await pc.setRemoteDescription(msg.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription(msg.sdp);
      } else if (msg.type === 'ice' && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch (err) { console.error(err); }
      } else if (msg.type === 'peer-left') {
        // Tear the connection down deliberately, otherwise its own teardown
        // fires a late 'failed' event that clobbers the status we set here.
        if (pc) { try { pc.close(); } catch {} pc = null; }
        channel = null;
        queue.length = 0;
        if (role === 'host') {
          setStatus('Waiting for phone…');
          showPane('pair');
          toast('Phone disconnected — scan again to reconnect');
        } else {
          setStatus('Computer disconnected', 'dead');
        }
      }
    });

    ws.addEventListener('close', () => {
      if (!channel || channel.readyState !== 'open') setStatus('Offline', 'dead');
    });
  }

  // --- UI wiring ----------------------------------------------------------
  el.drop.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => { enqueue(el.fileInput.files); el.fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) =>
    el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
  el.drop.addEventListener('drop', (e) => enqueue(e.dataTransfer.files));

  // Paste a screenshot or copied file straight into the transfer.
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); enqueue(files); }
  });

  // Copy the join link instead of scanning — useful for AirDrop-ing the link
  // to another app rather than using the camera.
  el.copyLink.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(joinUrl); toast('Link copied'); }
    catch { toast('Copy blocked by browser'); }
  });

  // Text/link composer: collapsed by default, expands inline on demand so it
  // never competes with the drop zone for attention.
  function openCompose() {
    el.textToggle.classList.add('hidden');
    el.compose.classList.remove('hidden');
    el.textInput.focus();
  }
  function closeCompose() {
    el.compose.classList.add('hidden');
    el.textToggle.classList.remove('hidden');
  }
  el.textToggle.addEventListener('click', openCompose);
  el.closeCompose.addEventListener('click', closeCompose);
  el.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCompose();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTextNow(); }
  });
  el.textInput.addEventListener('input', () => {
    el.textInput.style.height = 'auto';
    el.textInput.style.height = `${Math.min(el.textInput.scrollHeight, 120)}px`;
  });

  function sendTextNow() {
    const body = el.textInput.value.trim();
    if (!body) return;
    if (!channel || channel.readyState !== 'open') return toast('Not connected yet');
    channel.send(JSON.stringify({ t: 'text', body }));
    renderText(body, 'out');
    el.textInput.value = '';
    el.textInput.style.height = 'auto';
    closeCompose();
    toast('Text sent');
  }
  el.sendText.addEventListener('click', sendTextNow);

  // Auto-save: a real, persisted preference rather than something re-decided
  // every session.
  el.autoDl.checked = safeGet(AUTO_SAVE_KEY) === '1';
  el.autoChip.classList.toggle('active', el.autoDl.checked);
  el.autoDl.addEventListener('change', () => {
    safeSet(AUTO_SAVE_KEY, el.autoDl.checked ? '1' : '0');
    el.autoChip.classList.toggle('active', el.autoDl.checked);
  });

  // --- Boot ---------------------------------------------------------------
  (async function init() {
    if (isPeer) {
      showPane('connecting');
      setStatus('Connecting…');
      const token = new URLSearchParams(location.search).get('t');
      connectSignaling(location.pathname.split('/')[2], token);
    } else {
      setStatus('Waiting for phone…');
      const { id, token, joinUrl: url } = await (await fetch('/api/session', { method: 'POST' })).json();
      joinUrl = url;
      // Client-side QR generation (avoids blocking server on CPU, especially useful on slow networks)
      try {
        const qrDataUrl = await QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: '#2D2D2D', light: '#F9F8F6' } });
        el.qrImg.src = qrDataUrl;
      } catch (err) {
        console.error('QR generation failed:', err);
        toast('QR generation failed — use link instead');
      }
      showPane('pair');
      connectSignaling(id, token);
    }
  })();
})();
