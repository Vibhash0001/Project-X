// ---- DOM ----
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const roomInput = document.getElementById('roomCode');
const joinBtn = document.getElementById('joinBtn');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');
const sendProgressWrap = document.getElementById('sendProgressWrap');
const sendProgressBar = document.getElementById('sendProgressBar');
const incomingCard = document.getElementById('incomingCard');
const incomingName = document.getElementById('incomingName');
const acceptBtn = document.getElementById('acceptBtn');
const recvProgressWrap = document.getElementById('recvProgressWrap');
const recvProgressBar = document.getElementById('recvProgressBar');
const downloadLink = document.getElementById('downloadLink');
const receiveHint = document.getElementById('receiveHint');

// ---- State ----
let ws, pc, dataChannel;
let selectedFile = null;
let pendingSendFile = null;
let incomingMeta = null;
let incomingChunks = [];
let incomingBytes = 0;

const CHUNK_SIZE = 16 * 1024;
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function log(msg) {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Join room / signaling ----
joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('Enter a room code — use the same one on both devices.');
    return;
  }
  joinRoom(room);
});

function joinRoom(room) {
  const wsUrl = location.origin.replace(/^http/, 'ws');
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room }));
    log(`Joined room "${room}" — waiting for the other device…`);
    setStatus('Waiting for peer…');
  });

  ws.addEventListener('message', handleSignal);
  ws.addEventListener('close', () => setStatus('Disconnected from signaling server'));
  ws.addEventListener('error', () => log('Signaling connection error.'));

  joinBtn.disabled = true;
  roomInput.disabled = true;
}

async function handleSignal(event) {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'joined':
      if (msg.peerCount === 2) setStatus('Peer already here — connecting…');
      break;
    case 'room-full':
      alert('That room already has two devices connected. Try a different code.');
      break;
    case 'peer-joined':
      log('Peer joined — starting connection…');
      await createPeerConnection(true);
      break;
    case 'peer-left':
      setStatus('Peer disconnected');
      sendBtn.disabled = true;
      break;
    case 'offer':
      await createPeerConnection(false);
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
      break;
    case 'answer':
      await pc.setRemoteDescription(msg.sdp);
      break;
    case 'ice':
      if (msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          console.warn('ICE candidate error', err);
        }
      }
      break;
  }
}

// ---- WebRTC peer connection ----
async function createPeerConnection(isInitiator) {
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
  };

  pc.onconnectionstatechange = () => {
    setStatus(`Connection: ${pc.connectionState}`);
  };

  if (isInitiator) {
    dataChannel = pc.createDataChannel('file-transfer');
    setupDataChannel();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      setupDataChannel();
    };
  }
}

function setupDataChannel() {
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    log('Data channel open — ready to transfer.');
    setStatus('Connected ✓');
    sendBtn.disabled = !selectedFile;
  };

  dataChannel.onclose = () => log('Data channel closed.');

  dataChannel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'file-offer') onFileOffer(msg);
      if (msg.type === 'accept') onAccepted();
      if (msg.type === 'file-end') finalizeIncomingFile();
    } else {
      incomingChunks.push(event.data);
      incomingBytes += event.data.byteLength;
      if (incomingMeta) {
        const pct = Math.round((incomingBytes / incomingMeta.size) * 100);
        recvProgressBar.style.width = `${pct}%`;
      }
    }
  };
}

// ---- Sending: select -> offer -> (peer accepts) -> stream chunks ----
fileInput.addEventListener('change', () => {
  selectedFile = fileInput.files[0] || null;
  sendBtn.disabled = !(selectedFile && dataChannel && dataChannel.readyState === 'open');
  if (selectedFile) log(`Selected: ${selectedFile.name} (${formatBytes(selectedFile.size)})`);
});

sendBtn.addEventListener('click', () => offerFile(selectedFile));

function offerFile(file) {
  if (!file || !dataChannel || dataChannel.readyState !== 'open') return;
  pendingSendFile = file;
  sendBtn.disabled = true;
  dataChannel.send(JSON.stringify({ type: 'file-offer', name: file.name, size: file.size, mime: file.type }));
  log(`Offered "${file.name}" — waiting for the other device to accept…`);
}

async function onAccepted() {
  if (!pendingSendFile) return;
  const file = pendingSendFile;
  sendProgressWrap.hidden = false;
  sendProgressBar.style.width = '0%';

  const buffer = await file.arrayBuffer();
  let offset = 0;

  while (offset < buffer.byteLength) {
    if (dataChannel.bufferedAmount > 8 * CHUNK_SIZE) {
      await new Promise((res) => setTimeout(res, 20));
      continue;
    }
    dataChannel.send(buffer.slice(offset, offset + CHUNK_SIZE));
    offset += CHUNK_SIZE;
    sendProgressBar.style.width = `${Math.round((offset / buffer.byteLength) * 100)}%`;
  }

  dataChannel.send(JSON.stringify({ type: 'file-end' }));
  log(`Sent: ${file.name}`);
  pendingSendFile = null;
  sendBtn.disabled = false;
}

// ---- Receiving: offer arrives -> (user accepts) -> chunks stream in -> download ----
function onFileOffer(msg) {
  incomingMeta = msg;
  incomingChunks = [];
  incomingBytes = 0;

  incomingCard.hidden = false;
  incomingName.textContent = `${msg.name} — ${formatBytes(msg.size)}`;
  acceptBtn.hidden = false;
  downloadLink.hidden = true;
  receiveHint.textContent = 'Incoming file — accept it to start the transfer.';
  recvProgressWrap.hidden = true;
}

acceptBtn.addEventListener('click', () => {
  if (!dataChannel || dataChannel.readyState !== 'open') return;
  dataChannel.send(JSON.stringify({ type: 'accept' }));
  acceptBtn.hidden = true;
  recvProgressWrap.hidden = false;
  recvProgressBar.style.width = '0%';
  receiveHint.textContent = 'Receiving…';
});

function finalizeIncomingFile() {
  const blob = new Blob(incomingChunks, { type: incomingMeta.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  downloadLink.href = url;
  downloadLink.download = incomingMeta.name;
  downloadLink.textContent = `Download ${incomingMeta.name}`;
  downloadLink.hidden = false;
  receiveHint.textContent = 'Done.';
  log(`Received: ${incomingMeta.name}`);
  incomingChunks = [];
}


// ==========================================
// GESTURE RECOGNITION (MediaPipe Hands)
// ==========================================
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('canvas');
const canvasCtx = canvasElement.getContext('2d');
const gestureHint = document.getElementById('gestureHint');

let lastGesture = 'NEUTRAL';
let gestureHoldFrames = 0;
const HOLD_THRESHOLD = 15; // ~0.5 seconds at 30fps to confirm intent
let cooldownActive = false;
const COOLDOWN_MS = 2500; // 2.5s cooldown to prevent accidental double-triggers

function detectGesture(landmarks) {
  let extendedFingers = 0;
  // Check if finger tips are above (lower Y value) their PIP joints
  if (landmarks[8].y < landmarks[6].y) extendedFingers++;   // Index
  if (landmarks[12].y < landmarks[10].y) extendedFingers++; // Middle
  if (landmarks[16].y < landmarks[14].y) extendedFingers++; // Ring
  if (landmarks[20].y < landmarks[18].y) extendedFingers++; // Pinky

  if (extendedFingers >= 3) return 'THROWING'; // Open hand
  if (extendedFingers <= 1) return 'CATCHING'; // Closed fist
  return 'NEUTRAL';
}

function handleGesture(gesture) {
  if (gesture === 'THROWING') {
    gestureHint.innerHTML = 'Gesture: <strong style="color:var(--accent)">THROWING (Open Hand)</strong>';
  } else if (gesture === 'CATCHING') {
    gestureHint.innerHTML = 'Gesture: <strong style="color:var(--good)">CATCHING (Closed Fist)</strong>';
  } else {
    gestureHint.innerHTML = 'Gesture: <strong>NEUTRAL</strong> (Show Open Hand to Throw, Closed Fist to Catch)';
  }

  if (gesture === lastGesture) {
    gestureHoldFrames++;
  } else {
    gestureHoldFrames = 0;
    lastGesture = gesture;
  }

  if (gestureHoldFrames === HOLD_THRESHOLD && !cooldownActive) {
    triggerGestureAction(gesture);
  }
}

function triggerGestureAction(gesture) {
  /* 
   * NOTE: Mapped to match your UI text (Throw = Send, Catch = Receive). 
   * If you meant the reverse per your first prompt, simply swap 'THROWING' and 'CATCHING' below!
   */
  
  if (gesture === 'THROWING') {
    if (!sendBtn.disabled) {
      log('🖐️ Gesture detected: THROWING -> Triggering Send');
      sendBtn.click(); // Safely triggers your existing logic
      startGestureCooldown();
    } else {
      log('⚠️ Throw gesture ignored: No file selected or not connected.');
      startGestureCooldown(); 
    }
  } 
  else if (gesture === 'CATCHING') {
    if (!incomingCard.hidden && !acceptBtn.hidden) {
      log('✊ Gesture detected: CATCHING -> Triggering Accept');
      acceptBtn.click(); // Safely triggers your existing logic
      startGestureCooldown();
    } else {
      log('⚠️ Catch gesture ignored: No incoming file to accept.');
      startGestureCooldown();
    }
  }
}

function startGestureCooldown() {
  cooldownActive = true;
  gestureHint.innerHTML += ' <span style="color:var(--muted)">(Cooldown...)</span>';
  setTimeout(() => {
    cooldownActive = false;
    gestureHoldFrames = 0;
    lastGesture = 'NEUTRAL';
  }, COOLDOWN_MS);
}

// Initialize MediaPipe Hands
const hands = new Hands({locateFile: (file) => {
  return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
}});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.5
});

hands.onResults((results) => {
  canvasElement.width = videoElement.videoWidth || 640;
  canvasElement.height = videoElement.videoHeight || 480;
  
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  if (results.multiHandLandmarks) {
    for (const landmarks of results.multiHandLandmarks) {
      drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#4caf7d', lineWidth: 3});
      drawLandmarks(canvasCtx, landmarks, {color: '#e8a33d', lineWidth: 1, radius: 4});
      
      const gesture = detectGesture(landmarks);
      handleGesture(gesture);
    }
  } else {
    if (lastGesture !== 'NEUTRAL') {
      lastGesture = 'NEUTRAL';
      gestureHoldFrames = 0;
    }
  }
  canvasCtx.restore();
});

// Start Camera
const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({image: videoElement});
  },
  width: 640,
  height: 480
});

camera.start().then(() => {
  log('Camera started. Ready for gestures!');
}).catch(err => {
  log('Camera error: ' + err.message + '. Please allow camera access.');
  gestureHint.textContent = 'Camera access denied or unavailable.';
});