const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// roomCode -> Set of sockets (max 2 per room: one sender device, one receiver device)
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      currentRoom = msg.room;
      if (!rooms.has(currentRoom)) rooms.set(currentRoom, new Set());
      const peers = rooms.get(currentRoom);

      if (peers.size >= 2) {
        ws.send(JSON.stringify({ type: 'room-full' }));
        return;
      }

      peers.add(ws);
      ws.send(JSON.stringify({ type: 'joined', peerCount: peers.size }));
      peers.forEach((peer) => {
        if (peer !== ws) peer.send(JSON.stringify({ type: 'peer-joined' }));
      });
      return;
    }

    // Anything else (offer/answer/ice) just gets relayed to the other peer in the room
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).forEach((peer) => {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          peer.send(raw.toString());
        }
      });
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const peers = rooms.get(currentRoom);
      peers.delete(ws);
      peers.forEach((peer) => peer.send(JSON.stringify({ type: 'peer-left' })));
      if (peers.size === 0) rooms.delete(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running: http://localhost:${PORT}`);
  console.log('Open this URL on both devices (same Wi-Fi network) and use the same room code.');
});
