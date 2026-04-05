/* ─────────────────────────────────────────────────────────────────────────────
   TricallMeet – WebRTC Multi-Party Calling
   - Requests camera/mic BEFORE connecting to socket
   - Shows a clear permission screen so browser prompt appears naturally
   - Mesh topology (each peer ↔ each peer, max 3 total)
   ───────────────────────────────────────────────────────────────────────────── */

const roomId = location.pathname.split('/room/')[1];

// ─── STATE ───────────────────────────────────────────────────────────────────
let socket        = null;
let localStream   = null;
let micActive     = true;
let camActive     = true;
const peers       = {};   // peerId → { pc, tileEl }

// STUN for NAT traversal (works same-network and across networks via ngrok/deploy)
const ICE_CONFIG = {
  iceServers: [
    // STUN — discovers public IP, works for most networks
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // TURN — relays traffic when direct P2P is blocked (corporate/strict NAT)
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username:   'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

// ─── STEP 1: REQUEST CAMERA/MIC FROM PERMISSION SCREEN ───────────────────────
window.requestMedia = async function(withVideo) {
  const allowBtn  = document.getElementById('allowCamBtn');
  const audioBtn  = document.getElementById('audioOnlyBtn');
  const errEl     = document.getElementById('permError');

  allowBtn.textContent = 'Requesting access…';
  allowBtn.disabled    = true;
  audioBtn.disabled    = true;
  errEl.classList.add('hidden');

  const constraints = withVideo
    ? { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: true }
    : { video: false, audio: true };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.warn('[Media] getUserMedia failed:', err.name, err.message);

    if (withVideo) {
      // Camera failed → try audio only automatically
      errEl.classList.remove('hidden');
      allowBtn.textContent = 'Allow camera & mic';
      allowBtn.disabled    = false;
      audioBtn.disabled    = false;

      // Try audio-only silently as fallback suggestion
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        errEl.textContent = '📷 Camera not available — joining with audio only.';
        errEl.style.background = 'rgba(66,133,244,0.1)';
        errEl.style.borderColor = 'rgba(66,133,244,0.3)';
        errEl.style.color = '#8ab4f8';
        errEl.classList.remove('hidden');
        setTimeout(() => enterRoom(), 1200);
        return;
      } catch (e2) {
        errEl.textContent = '❌ Could not access camera or microphone. Check your browser permissions and try again.';
        errEl.classList.remove('hidden');
        return;
      }
    } else {
      errEl.textContent = '❌ Microphone access denied. Please allow it in browser settings.';
      errEl.classList.remove('hidden');
      allowBtn.textContent = 'Allow camera & mic';
      allowBtn.disabled    = false;
      audioBtn.disabled    = false;
      return;
    }
  }

  enterRoom();
};

// ─── STEP 2: ENTER ROOM AFTER PERMISSION ─────────────────────────────────────
function enterRoom() {
  // Hide permission screen
  document.getElementById('permissionScreen').classList.add('hidden');

  // Show local video
  const videoEl = document.getElementById('localVideo');
  const avatarEl = document.getElementById('localAvatar');

  const hasVideo = localStream.getVideoTracks().length > 0 &&
                   localStream.getVideoTracks()[0].enabled;

  if (hasVideo) {
    videoEl.srcObject = localStream;
    videoEl.style.display = 'block';
    avatarEl.style.display = 'none';
    camActive = true;
  } else {
    videoEl.style.display = 'none';
    avatarEl.style.display = 'flex';
    camActive = false;
    // Update cam button state
    setCamOff();
  }

  // Init controls state
  updateMicBtn();
  updateCamBtn();

  // Now connect to signaling server
  connectSocket();
}

// ─── SOCKET CONNECTION ────────────────────────────────────────────────────────
function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('[Socket] connected:', socket.id);
    setStatus('connecting', 'Joining room…');

    socket.emit('join-room', roomId, ({ error, peers: existingPeers }) => {
      if (error) {
        document.getElementById('errorOverlay').classList.remove('hidden');
        setStatus('error', 'Room full');
        return;
      }

      if (existingPeers.length === 0) {
        setStatus('connected', 'Waiting for others…');
      } else {
        setStatus('connecting', 'Connecting to peers…');
        existingPeers.forEach(peerId => callPeer(peerId));
      }
    });
  });

  socket.on('user-joined', (peerId) => {
    console.log('[Room] user joined:', peerId);
    showToast('👋 Someone joined the call!');
    // They'll send us an offer
  });

  socket.on('offer', async ({ from, offer }) => {
    if (!peers[from]) createPeerEntry(from);
    const pc = peers[from].pc;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, answer });
  });

  socket.on('answer', async ({ from, answer }) => {
    if (!peers[from]) return;
    await peers[from].pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (!peers[from]) return;
    try {
      await peers[from].pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('[ICE]', e);
    }
  });

  socket.on('user-disconnected', (peerId) => {
    console.log('[Room] disconnected:', peerId);
    if (peers[peerId]) {
      peers[peerId].pc.close();
      removeRemoteTile(peerId);
      delete peers[peerId];
      showToast('👋 Someone left the call.');
    }
    if (Object.keys(peers).length === 0) {
      setStatus('connected', 'Waiting for others…');
    }
  });

  socket.on('disconnect', () => {
    setStatus('error', 'Disconnected');
  });
}

// ─── WEBRTC PEER CONNECTION ───────────────────────────────────────────────────
function createPeerEntry(peerId) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  // Add our local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // Receive remote stream
  pc.ontrack = ({ streams: [stream] }) => {
    if (!peers[peerId]) return;
    showRemoteStream(peerId, stream);
  };

  // Relay ICE
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && socket) {
      socket.emit('ice-candidate', { to: peerId, candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[PC ${peerId}]`, pc.connectionState);
    if (pc.connectionState === 'connected') {
      setStatus('connected', 'Connected');
    } else if (['failed','disconnected'].includes(pc.connectionState)) {
      setStatus('error', 'Connection issue');
    }
  };

  const tileEl = createRemoteTile(peerId);
  peers[peerId] = { pc, tileEl };
  return pc;
}

async function callPeer(peerId) {
  const pc = createPeerEntry(peerId);
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: peerId, offer });
}

// ─── VIDEO TILE MANAGEMENT ────────────────────────────────────────────────────
function createRemoteTile(peerId) {
  const grid = document.getElementById('videoGrid');
  const tile = document.createElement('div');
  tile.id        = 'tile-' + peerId;
  tile.className = 'video-tile remote-tile';
  tile.innerHTML = `
    <div class="tile-connecting" id="conn-${peerId}">
      <div class="spinner"></div>
      <span>Connecting…</span>
    </div>
    <div class="avatar-bg" id="av-${peerId}" style="display:none">
      <div class="avatar-circle">👤</div>
      <div class="avatar-name">Peer</div>
    </div>
    <video id="video-${peerId}" autoplay playsinline style="display:none"></video>
    <div class="tile-label">Participant</div>
    <div class="tile-mic-status" id="mic-${peerId}">🎙️</div>
  `;
  grid.appendChild(tile);
  updateGrid();
  return tile;
}

function showRemoteStream(peerId, stream) {
  const video  = document.getElementById('video-' + peerId);
  const conn   = document.getElementById('conn-' + peerId);
  const avatar = document.getElementById('av-' + peerId);

  if (conn) conn.remove();

  const hasVideo = stream.getVideoTracks().length > 0;
  if (video) {
    if (hasVideo) {
      video.srcObject = stream;
      video.style.display = 'block';
      if (avatar) avatar.style.display = 'none';
    } else {
      video.style.display = 'none';
      if (avatar) avatar.style.display = 'flex';
    }
  }
}

function removeRemoteTile(peerId) {
  const tile = document.getElementById('tile-' + peerId);
  if (tile) {
    tile.style.opacity   = '0';
    tile.style.transform = 'scale(0.92)';
    tile.style.transition = 'all 0.25s ease';
    setTimeout(() => { tile.remove(); updateGrid(); }, 250);
  }
}

function updateGrid() {
  const grid  = document.getElementById('videoGrid');
  const count = 1 + Object.keys(peers).length;
  grid.className = 'video-grid p' + Math.min(count, 3);
  document.getElementById('pCount').textContent = count;
}

// ─── STATUS ───────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const el = document.getElementById('connStatus');
  el.className = 'conn-pill ' + state;
  document.getElementById('connText').textContent = text;
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
function showToast(msg, ms = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ─── CONTROLS ─────────────────────────────────────────────────────────────────
function toggleMic() {
  if (!localStream) return;
  micActive = !micActive;
  localStream.getAudioTracks().forEach(t => { t.enabled = micActive; });
  updateMicBtn();
  if (!micActive) showToast('🔇 You are muted');
}

function updateMicBtn() {
  const btn   = document.getElementById('micBtn');
  const icon  = document.getElementById('micIcon');
  const label = document.getElementById('micLabel');
  const statusEl = document.getElementById('localMicStatus');
  if (micActive) {
    btn.classList.remove('off');
    icon.textContent  = '🎙️';
    label.textContent = 'Mute';
    if (statusEl) statusEl.textContent = '🎙️';
  } else {
    btn.classList.add('off');
    icon.textContent  = '🔇';
    label.textContent = 'Unmute';
    if (statusEl) statusEl.textContent = '🔇';
  }
}

function toggleCam() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  if (videoTracks.length === 0) {
    showToast('📷 No camera available');
    return;
  }
  camActive = !camActive;
  videoTracks.forEach(t => { t.enabled = camActive; });
  updateCamBtn();
  if (!camActive) showToast('📷 Camera off');
}

function updateCamBtn() {
  const btn   = document.getElementById('camBtn');
  const icon  = document.getElementById('camIcon');
  const label = document.getElementById('camLabel');
  const videoEl  = document.getElementById('localVideo');
  const avatarEl = document.getElementById('localAvatar');
  if (camActive) {
    btn.classList.remove('off');
    icon.textContent  = '📷';
    label.textContent = 'Camera';
    if (videoEl) videoEl.style.display = 'block';
    if (avatarEl) avatarEl.style.display = 'none';
  } else {
    btn.classList.add('off');
    icon.textContent  = '🚫';
    label.textContent = 'Show cam';
    if (videoEl) videoEl.style.display = 'none';
    if (avatarEl) avatarEl.style.display = 'flex';
  }
}

function setCamOff() { camActive = false; updateCamBtn(); }

function hangUp() {
  Object.values(peers).forEach(({ pc }) => pc.close());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (socket) socket.disconnect();
  showToast('Call ended');
  setTimeout(() => { window.location.href = '/'; }, 700);
}

window.copyRoomLink = function() {
  const link = location.href;
  navigator.clipboard.writeText(link)
    .then(() => showToast('✅ Link copied! Share it to invite people.'))
    .catch(() => {
      // Fallback
      const inp = document.createElement('input');
      inp.value = link;
      document.body.appendChild(inp);
      inp.select();
      document.execCommand('copy');
      inp.remove();
      showToast('✅ Link copied!');
    });
};

window.toggleMic = toggleMic;
window.toggleCam = toggleCam;
window.hangUp    = hangUp;
