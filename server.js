const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configuração mais permissiva do Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["*"],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  path: '/socket.io/',
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e8
});

const rooms = new Map();
const peers = new Map();

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Health check
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ Construct 3 Signalling Server Online</h1>
    <p>Connections: ${io.engine.clientsCount}</p>
    <p>Rooms: ${rooms.size}</p>
    <p>Server Time: ${new Date().toISOString()}</p>
  `);
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    connections: io.engine.clientsCount,
    rooms: rooms.size,
    peers: peers.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Socket.IO events
io.on('connection', (socket) => {
  console.log('✅ Cliente conectado:', socket.id, '| Total:', io.engine.clientsCount);
  
  peers.set(socket.id, {
    id: socket.id,
    rooms: new Set()
  });

  // Join room
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(socket.id);
    
    if (peers.has(socket.id)) {
      peers.get(socket.id).rooms.add(roomId);
    }
    
    console.log(`👥 ${socket.id} entrou na sala ${roomId} | Membros: ${rooms.get(roomId).size}`);
    
    // Notifica outros peers
    socket.to(roomId).emit('user-joined', {
      peerId: socket.id,
      roomId: roomId
    });
    
    // Confirma para o cliente
    socket.emit('joined-room', {
      roomId: roomId,
      peerId: socket.id
    });
  });

  // Signal (WebRTC)
  socket.on('signal', (data) => {
    if (data && data.to) {
      io.to(data.to).emit('signal', {
        from: socket.id,
        signal: data.signal,
        data: data.data
      });
    }
  });

  // Broadcast to room
  socket.on('room-message', (data) => {
    if (data && data.roomId) {
      socket.to(data.roomId).emit('room-message', {
        from: socket.id,
        data: data.data
      });
    }
  });

  // Leave room
  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(socket.id);
      if (rooms.get(roomId).size === 0) {
        rooms.delete(roomId);
      }
    }
    
    if (peers.has(socket.id)) {
      peers.get(socket.id).rooms.delete(roomId);
    }
    
    socket.to(roomId).emit('user-left', {
      peerId: socket.id,
      roomId: roomId
    });
    
    console.log(`👋 ${socket.id} saiu da sala ${roomId}`);
  });

  // Disconnect
  socket.on('disconnect', (reason) => {
    console.log('❌ Cliente desconectado:', socket.id, '| Razão:', reason);
    
    // Remove de todas as salas
    if (peers.has(socket.id)) {
      const peerRooms = peers.get(socket.id).rooms;
      peerRooms.forEach(roomId => {
        if (rooms.has(roomId)) {
          rooms.get(roomId).delete(socket.id);
          if (rooms.get(roomId).size === 0) {
            rooms.delete(roomId);
          }
        }
        socket.to(roomId).emit('user-left', {
          peerId: socket.id,
          roomId: roomId
        });
      });
      peers.delete(socket.id);
    }
  });

  // Error handling
  socket.on('error', (error) => {
    console.error('Socket error:', socket.id, error);
  });
});

// Error handling do servidor
server.on('error', (error) => {
  console.error('Server error:', error);
});

io.engine.on('connection_error', (err) => {
  console.error('Connection error:', err);
});

// Inicia o servidor
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 WebSocket path: /socket.io/`);
  console.log(`🌍 Acesse: http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, fechando servidor...');
  server.close(() => {
    console.log('Servidor fechado');
    process.exit(0);
  });
});