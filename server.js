const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// WebSocket Server puro (não Socket.IO)
const wss = new WebSocket.Server({ 
  server,
  path: '/',
  perMessageDeflate: false
});

const rooms = new Map();
const clients = new Map();

// Health check HTTP
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ Construct 3 Signalling Server Online</h1>
    <p>Active Connections: ${wss.clients.size}</p>
    <p>Rooms: ${rooms.size}</p>
    <p>Server Time: ${new Date().toISOString()}</p>
  `);
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    connections: wss.clients.size,
    rooms: rooms.size,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// WebSocket connection
wss.on('connection', (ws, req) => {
  const clientId = generateId();
  clients.set(ws, {
    id: clientId,
    rooms: new Set()
  });
  
  console.log('✅ Cliente conectado:', clientId, '| Total:', wss.clients.size);
  
  // Envia ID do cliente
  ws.send(JSON.stringify({
    type: 'id',
    id: clientId
  }));

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(ws, message);
    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      console.log('❌ Cliente desconectado:', client.id);
      
      // Remove de todas as salas
      client.rooms.forEach(roomId => {
        if (rooms.has(roomId)) {
          rooms.get(roomId).delete(ws);
          
          // Notifica outros na sala
          broadcast(roomId, {
            type: 'peer-disconnect',
            id: client.id
          }, ws);
          
          // Remove sala vazia
          if (rooms.get(roomId).size === 0) {
            rooms.delete(roomId);
          }
        }
      });
      
      clients.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function handleMessage(ws, message) {
  const client = clients.get(ws);
  if (!client) return;

  switch (message.type) {
    case 'join':
      handleJoin(ws, client, message);
      break;
      
    case 'leave':
      handleLeave(ws, client, message);
      break;
      
    case 'signal':
      handleSignal(ws, client, message);
      break;
      
    case 'broadcast':
      handleBroadcast(ws, client, message);
      break;
      
    default:
      // Encaminha mensagens desconhecidas para a sala
      if (message.room) {
        broadcast(message.room, message, ws);
      }
  }
}

function handleJoin(ws, client, message) {
  const roomId = message.room;
  
  if (!roomId) return;
  
  // Cria sala se não existe
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  
  // Adiciona cliente à sala
  rooms.get(roomId).add(ws);
  client.rooms.add(roomId);
  
  console.log(`👥 ${client.id} entrou na sala ${roomId} | Membros: ${rooms.get(roomId).size}`);
  
  // Lista de peers já na sala
  const peers = [];
  rooms.get(roomId).forEach(peerWs => {
    if (peerWs !== ws && clients.has(peerWs)) {
      peers.push(clients.get(peerWs).id);
    }
  });
  
  // Confirma join para o cliente
  ws.send(JSON.stringify({
    type: 'joined',
    room: roomId,
    id: client.id,
    peers: peers
  }));
  
  // Notifica outros peers
  broadcast(roomId, {
    type: 'peer-connect',
    id: client.id
  }, ws);
}

function handleLeave(ws, client, message) {
  const roomId = message.room;
  
  if (!roomId || !rooms.has(roomId)) return;
  
  rooms.get(roomId).delete(ws);
  client.rooms.delete(roomId);
  
  // Notifica outros
  broadcast(roomId, {
    type: 'peer-disconnect',
    id: client.id
  }, ws);
  
  // Remove sala vazia
  if (rooms.get(roomId).size === 0) {
    rooms.delete(roomId);
  }
  
  console.log(`👋 ${client.id} saiu da sala ${roomId}`);
}

function handleSignal(ws, client, message) {
  // Encaminha sinal WebRTC para peer específico
  const targetId = message.to;
  
  if (!targetId) return;
  
  // Encontra o WebSocket do destinatário
  for (const [peerWs, peerClient] of clients.entries()) {
    if (peerClient.id === targetId) {
      peerWs.send(JSON.stringify({
        type: 'signal',
        from: client.id,
        signal: message.signal,
        data: message.data
      }));
      break;
    }
  }
}

function handleBroadcast(ws, client, message) {
  const roomId = message.room;
  
  if (!roomId || !rooms.has(roomId)) return;
  
  broadcast(roomId, {
    type: 'message',
    from: client.id,
    data: message.data
  }, ws);
}

function broadcast(roomId, message, excludeWs = null) {
  if (!rooms.has(roomId)) return;
  
  const messageStr = JSON.stringify(message);
  
  rooms.get(roomId).forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  });
}

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Inicia servidor
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor WebSocket rodando na porta ${PORT}`);
  console.log(`🌍 HTTP: http://0.0.0.0:${PORT}`);
  console.log(`📡 WebSocket: ws://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, fechando servidor...');
  wss.clients.forEach(ws => ws.close());
  server.close(() => {
    console.log('Servidor fechado');
    process.exit(0);
  });
});