# Catch & Throw — File Transfer (MVP)

Peer-to-peer file transfer between two browser devices over WebRTC, with a
tiny signaling server to help them find each other. This is Phase 1: real
buttons for "select", "send", and "accept". Phase 2 will swap those clicks
for a catching / throwing hand gesture, without touching the transfer logic.

## Run it

```bash
npm install
npm start
```

Then, on **both devices** (same Wi-Fi network):

1. Open `http://<your-computer's-local-IP>:3000` (use `localhost:3000` if
   testing in two tabs on one machine).
2. Type the **same room code** on both devices and click **Connect**.
3. On the sending device: choose a file, click **Throw file →**.
4. On the receiving device: click **← Catch it** to start the transfer.
5. When it finishes, a download link appears.

To find your local IP: `ipconfig getifaddr en0` (Mac) or `ipconfig` (Windows,
look for IPv4 Address).

## How it works

- `server.js` — a small Express + `ws` server. It does **not** touch file
  data; it only relays WebRTC handshake messages (offer/answer/ICE
  candidates) between the two devices in a room, so they can open a direct
  connection.
- `public/app.js` — once connected, opens an `RTCDataChannel` and sends the
  file in 16 KB chunks straight to the other browser. The file itself never
  passes through the server.
- The send/accept handshake (`file-offer` → `accept` → chunks → `file-end`)
  is deliberately explicit: `offerFile()` and the accept click are the two
  functions gestures will call in Phase 2 (`throw` → `offerFile()`, `catch`
  → the accept handler).

## Known limits (fine for a first version)

- Works reliably on the same network. Crossing networks (e.g. two different
  Wi-Fis) will usually need a TURN relay server in `RTC_CONFIG`, which this
  MVP doesn't include yet.
- One file at a time, one room = one sender + one receiver.
- No file-size cap is enforced, but very large files will take a while —
  16 KB chunks with WebRTC backpressure keeps things stable rather than fast.

## Next: adding gestures

1. Add MediaPipe Hands (`@mediapipe/hands` via CDN script) to `index.html`,
   pointed at a hidden `<video>` fed by `getUserMedia`.
2. From the 21 hand landmarks it returns per frame, track the distance
   between fingertips and palm across frames:
   - Fingers closing quickly while hovering over the file input → treat as
     **catch**, call `offerFile(selectedFile)`.
   - Fingers opening with a fast forward hand-velocity spike → treat as
     **throw**, on the receiving device call the same function the
     **Accept** button calls.
3. Keep the buttons visible as a fallback — gesture misfires shouldn't lock
   anyone out of the app.
