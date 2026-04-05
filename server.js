const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_PARTICIPANTS = 3;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Room map: roomId -> Set of socket IDs
const rooms = new Map();

// Serve room page for any /room/* path
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ─── JOIN ROOM ───────────────────────────────────────────────────────────────
  socket.on('join-room', (roomId, callback) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }

    const room = rooms.get(roomId);

    if (room.size >= MAX_PARTICIPANTS) {
      callback({ error: 'Room is full (max 3 participants).' });
      return;
    }

    room.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    // Tell the new user who else is already in the room
    const peers = [...room].filter(id => id !== socket.id);
    callback({ peers });

    // Tell existing peers about the new user
    socket.to(roomId).emit('user-joined', socket.id);

    console.log(`[Room ${roomId}] ${socket.id} joined. Size: ${room.size}`);
  });

  // ─── WEBRTC SIGNALING ────────────────────────────────────────────────────────
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ─── DISCONNECT ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.delete(socket.id);
      socket.to(roomId).emit('user-disconnected', socket.id);
      if (room.size === 0) rooms.delete(roomId);
      console.log(`[-] ${socket.id} left room ${roomId}. Size: ${room.size}`);
    }
    console.log(`[-] Socket disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 TricallMeet running at http://localhost:${PORT}\n`);
});
