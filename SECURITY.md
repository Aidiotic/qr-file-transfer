# Security Considerations

Beam transfers files directly between devices using WebRTC Data Channels with end-to-end DTLS encryption. The pairing mechanism is based on a shared secret (the QR URL) plus a random token, making it resistant to casual network snooping.

**Threat model:** Designed for trusted LANs. Does not harden against active attackers on the same network with ARP spoofing or packet injection capabilities. For untrusted networks, use the hardening options below (HTTPS tunnels, Tailscale, etc).

## 1. Token-Based Authentication (Implemented)
When the host creates a session, a random 16-character hexadecimal token is generated alongside the session UUID. This token is embedded in the QR code (as a URL parameter `?t=<token>`) and is **required** when the peer attempts to connect to the WebSocket signaling server. 
- This prevents unauthorized devices on the same local network from joining a session by guessing the UUID.
- If the token is missing or incorrect, the WebSocket connection is immediately rejected.

## 2. WebRTC Secure Transport
WebRTC automatically uses **DTLS (Datagram Transport Layer Security)** for all peer-to-peer data channels. This means:
- The file payload is strictly encrypted end-to-end between the phone and the computer.
- It cannot be intercepted or read by other devices on the LAN, nor by the signaling server (which only handles connection negotiation, not the file data).

## 3. Accessibility & Safety
All UI controls are keyboard accessible and announced to assistive technology. This does **not** expand the attack surface:
- Text sent between peers is rendered via `createTextNode` (never `innerHTML`), preventing markup injection.
- File names are displayed as text only (no script execution).
- WebRTC credentials and DTLS keys are handled by the browser engine, not exposed to JS.

## 4. Local TLS / HTTPS (Required for some browsers)
WebRTC requires a "Secure Context" (HTTPS or `localhost`) on modern browsers to function correctly, particularly for clipboard access or advanced camera APIs, and sometimes even for WebRTC itself depending on the network configuration.

Since this app is hosted on a local IP (e.g., `192.168.1.50`), getting a valid SSL certificate is natively challenging. Here are the recommended ways to run the signaling server securely:

### Option A: Using a Reverse Proxy Tunnel (Easiest)
Use a tool like **ngrok** or **Cloudflare Tunnels** to expose your local port `6798` to a secure HTTPS endpoint.
```bash
# Using ngrok
ngrok http 6798
```
This gives you an `https://xxxx.ngrok.app` URL which you can open on your host machine. The QR code will automatically use this secure URL for the phone to scan.

### Option B: Local Self-Signed Certificates
You can use `mkcert` to generate a locally trusted certificate for your local IP, and update `server.js` to serve via HTTPS.
```bash
mkcert -install
mkcert 192.168.1.50 localhost 127.0.0.1
```
Then, configure the Express server in `server.js` to use `https.createServer` with the generated key and cert files.

### Option C: Tailscale (Advanced, Highly Secure)
If both devices are on a Tailscale mesh network, you can use Tailscale MagicDNS and automatic HTTPS certificates to host the app securely on your private mesh network without exposing it to the broader local Wi-Fi or the internet.
