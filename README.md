# ⚡ Beam — QR File Transfer

Move files between your phone and computer by scanning a QR code. No Bluetooth, no AirDrop, no app install, no cloud upload. Files travel **directly between the two devices** over your local Wi‑Fi via WebRTC.

```bash
npm install
node server.js
```

Open the printed LAN URL on your computer, scan the QR with your phone's camera, and start sending — in either direction.

## How it works

| Layer | What it does |
|---|---|
| **Signaling** | Express + `ws`. Relays only WebRTC SDP/ICE metadata between the two devices. |
| **Transport** | `RTCDataChannel`, peer‑to‑peer. **File bytes never touch the server.** |
| **Pairing** | The QR encodes `http://<lan-ip>:<port>/s/<random-uuid>`. Scanning it joins that session. |

Because both devices are on the same LAN, a public STUN server is enough — no TURN relay and no public hosting required.

## Features

- **Any direction** — phone → computer or computer → phone, same UI on both.
- **Multi‑file queue** — drag & drop, browse, or paste (⌘V a screenshot straight into the transfer).
- **Send text & links** — a snippet box for URLs, Wi‑Fi passwords, or code, with one‑tap copy on the far end.
- **Live progress** — per‑file percentage, throughput in MB/s, and ETA.
- **Auto‑save** — optional; received files download automatically.
- **Reconnect** — if the phone locks or backgrounds its tab, the same QR can simply be scanned again.
- **No size or type limits.**

## Performance notes

Two things dominate throughput, and both are handled explicitly in [`public/app.js`](public/app.js):

- **Backpressure.** The sender checks `RTCDataChannel.bufferedAmount` and stops reading from disk once 8 MB is in flight, resuming on `bufferedamountlow`. Without this, `send()` queues without bound and a large file can take the tab down.
- **Block reads + chunk sizing.** The file is read from disk in 8 MB blocks and pushed out in 256 KB chunks (clamped to `pc.sctp.maxMessageSize`). Far fewer disk round‑trips and event‑loop turns than naive 64 KB `FileReader` chunking.

On the receiving side, chunks are sealed into `Blob`s every 8 MB. Browsers spill Blobs to disk, so JS heap stays flat even on multi‑gigabyte transfers instead of accumulating every chunk in memory.

Measured locally: **64 MB transferred byte‑perfect in 5.6 s (~11.4 MB/s)** with three files queued back‑to‑back.

## Security

- Session IDs are `crypto.randomUUID()`, plus a separate random 16‑hex‑char token required on the signaling WebSocket — the QR URL *is* the shared secret, and guessing the UUID alone isn't enough to join. See [`SECURITY.md`](SECURITY.md) for details and hardening options (HTTPS tunnels, Tailscale, etc).
- A session holds exactly one host and one peer slot; extra joiners are rejected.
- Unpaired sessions (host opened the page but no phone ever scanned) are swept after 5 minutes so they don't accumulate in memory.
- WebRTC data channels are **DTLS‑encrypted end to end** by default.
- The signaling server sees SDP/ICE only — never file contents.
- Received text is rendered via `createTextNode`, never `innerHTML`, so a sender cannot inject markup.

Runs over plain HTTP/WS for LAN simplicity. **Use it on a trusted network; don't expose the port to the internet.**

## Customization

- `[FILL: max file size]` — none enforced; add a check in `sendFile()` if you want one.
- `[FILL: allowed file types]` — none enforced; filter in `enqueue()` if you want a whitelist.
- `PORT` — override with the `PORT` env var.
