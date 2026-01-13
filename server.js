const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

const rooms = new Map();

// Página inicial para testar se está funcionando
app.get('/', (req, res) => {
  res.send('Construct 3 Signalling Server está rodando! ✅');
});

// Status do servidor
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    connections: io.engine.clientsCount,
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

io.on('connection', (socket) => {
  console.log('✅ Cliente conectado:', socket.id);
  
  // Entrar em uma sala
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(socket.id);
    
    console.log(`👥 ${socket.id} entrou na sala ${roomId}`);
    socket.to(roomId).emit('user-joined', socket.id);
  });
  
  // Encaminhar sinais WebRTC
  socket.on('signal', (data) => {
    io.to(data.to).emit('signal', {
      from: socket.id,
      signal: data.signal
    });
  });
  
  // Sair de uma sala
  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    if (rooms.has(roomId)) {
      rooms.get(roomId).delete(socket.id);
      if (rooms.get(roomId).size === 0) {
        rooms.delete(roomId);
      }
    }
    socket.to(roomId).emit('user-left', socket.id);
  });
  
  // Desconexão
  socket.on('disconnect', () => {
    console.log('❌ Cliente desconectado:', socket.id);
    rooms.forEach((users, roomId) => {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        socket.to(roomId).emit('user-left', socket.id);
        if (users.size === 0) {
          rooms.delete(roomId);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

