// ============================================
// Construct 3 Signalling Server
// Compatible with Construct 2/3 Multiplayer
// ============================================

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');

// ============================================
// CONFIGURAÇÃO
// ============================================
const config = {
  server_host: "0.0.0.0",
  server_port: process.env.PORT || 10000,
  
  // SSL (deixe null para desenvolvimento)
  ssl_key_file: null,
  ssl_cert_file: null,
  
  // STUN/TURN servers (padrões do Google/Mozilla)
  ice_servers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" }
  ],
  
  // Limites
  max_rooms: 1000,
  max_peers_per_room: 50,
  
  // Timeouts
  room_timeout: 300000,  // 5 minutos
  ping_interval: 30000   // 30 segundos
};

// ============================================
// SERVIDOR HTTP/HTTPS
// ============================================
let server;
if (config.ssl_key_file && config.ssl_cert_file) {
  const ssl_options = {
    key: fs.readFileSync(config.ssl_key_file),
    cert: fs.readFileSync(config.ssl_cert_file)
  };
  server = https.createServer(ssl_options, handleHTTP);
  console.log('🔒 Servidor HTTPS iniciado');
} else {
  server = http.createServer(handleHTTP);
  console.log('🔓 Servidor HTTP iniciado (sem SSL)');
}

function handleHTTP(req, res) {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Construct 3 Signalling Server</title>
        <style>
          body { font-family: Arial; padding: 40px; background: #1a1a2e; color: #eee; }
          h1 { color: #0f3460; }
          .stat { background: #16213e; padding: 15px; margin: 10px 0; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h1>✅ Construct 3 Signalling Server Online</h1>
        <div class="stat">Active Connections: ${wss.clients.size}</div>
        <div class="stat">Active Rooms: ${rooms.size}</div>
        <div class="stat">Uptime: ${Math.floor(process.uptime())}s</div>
        <div class="stat">Server Time: ${new Date().toISOString()}</div>
      </body>
      </html>
    `);
  } else if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      connections: wss.clients.size,
      rooms: rooms.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ============================================
// WEBSOCKET SERVER
// ============================================
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

// ============================================
// ESTRUTURAS DE DADOS
// ============================================
const rooms = new Map();
const peers = new Map();

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function sendMessage(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToRoom(roomId, msg, excludeWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const msgStr = JSON.stringify(msg);
  room.peers.forEach(peerId => {
    const peer = peers.get(peerId);
    if (peer && peer.ws !== excludeWs && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(msgStr);
    }
  });
}

function cleanupPeer(ws) {
  const peer = peers.get(ws.peerId);
  if (!peer) return;
  
  // Remove de todas as salas
  peer.rooms.forEach(roomId => {
    const room = rooms.get(roomId);
    if (room) {
      room.peers.delete(ws.peerId);
      
      // Notifica outros peers
      broadcastToRoom(roomId, {
        type: 'peer-disconnect',
        id: ws.peerId
      });
      
      // Remove sala vazia ou se era o host
      if (room.peers.size === 0 || room.host === ws.peerId) {
        rooms.delete(roomId);
        console.log(`🗑️  Sala removida: ${roomId}`);
      }
    }
  });
  
  peers.delete(ws.peerId);
}

// ============================================
// HANDLERS DE MENSAGENS
// ============================================

function handleLogin(ws, msg) {
  if (peers.has(ws.peerId)) {
    sendMessage(ws, { type: 'error', message: 'Already logged in' });
    return;
  }
  
  peers.set(ws.peerId, {
    id: ws.peerId,
    ws: ws,
    alias: msg.alias || 'Anonymous',
    rooms: new Set()
  });
  
  console.log(`✅ Login: ${msg.alias} (${ws.peerId})`);
  
  sendMessage(ws, {
    type: 'login',
    id: ws.peerId,
    ice_servers: config.ice_servers
  });
}

function handleJoin(ws, msg) {
  const peer = peers.get(ws.peerId);
  if (!peer) {
    sendMessage(ws, { type: 'error', message: 'Not logged in' });
    return;
  }
  
  const roomId = msg.room;
  let room = rooms.get(roomId);
  
  // Cria sala se não existe (peer se torna host)
  if (!room) {
    if (rooms.size >= config.max_rooms) {
      sendMessage(ws, { type: 'error', message: 'Server full' });
      return;
    }
    
    room = {
      id: roomId,
      host: ws.peerId,
      locked: false,
      peers: new Set(),
      created: Date.now()
    };
    rooms.set(roomId, room);
    console.log(`🏠 Sala criada: ${roomId} por ${peer.alias}`);
  }
  
  // Verifica limites
  if (room.peers.size >= config.max_peers_per_room) {
    sendMessage(ws, { type: 'error', message: 'Room full' });
    return;
  }
  
  if (room.locked && room.host !== ws.peerId) {
    sendMessage(ws, { type: 'error', message: 'Room locked' });
    return;
  }
  
  // Adiciona peer à sala
  room.peers.add(ws.peerId);
  peer.rooms.add(roomId);
  
  const isHost = room.host === ws.peerId;
  
  console.log(`👥 ${peer.alias} entrou na sala ${roomId} ${isHost ? '(HOST)' : '(PEER)'}`);
  
  // Notifica o peer que entrou
  sendMessage(ws, {
    type: 'join',
    room: roomId,
    id: ws.peerId,
    host: isHost
  });
  
  // Envia lista de peers já na sala (exceto ele mesmo)
  const peersList = [];
  room.peers.forEach(peerId => {
    if (peerId !== ws.peerId) {
      const p = peers.get(peerId);
      if (p) {
        peersList.push({
          id: p.id,
          alias: p.alias
        });
      }
    }
  });
  
  if (peersList.length > 0) {
    sendMessage(ws, {
      type: 'peer-list',
      peers: peersList
    });
  }
  
  // Notifica outros peers na sala
  broadcastToRoom(roomId, {
    type: 'peer-connect',
    id: ws.peerId,
    alias: peer.alias
  }, ws);
}

function handleLeave(ws, msg) {
  const peer = peers.get(ws.peerId);
  if (!peer) return;
  
  const roomId = msg.room;
  const room = rooms.get(roomId);
  
  if (!room || !peer.rooms.has(roomId)) return;
  
  room.peers.delete(ws.peerId);
  peer.rooms.delete(roomId);
  
  console.log(`👋 ${peer.alias} saiu da sala ${roomId}`);
  
  // Notifica outros
  broadcastToRoom(roomId, {
    type: 'peer-disconnect',
    id: ws.peerId
  });
  
  // Remove sala vazia ou se era host
  if (room.peers.size === 0 || room.host === ws.peerId) {
    rooms.delete(roomId);
    console.log(`🗑️  Sala removida: ${roomId}`);
  }
  
  sendMessage(ws, {
    type: 'leave',
    room: roomId
  });
}

function handleSignal(ws, msg) {
  const targetId = msg.to;
  const targetPeer = peers.get(targetId);
  
  if (!targetPeer) {
    sendMessage(ws, { type: 'error', message: 'Peer not found' });
    return;
  }
  
  // Encaminha sinal WebRTC
  sendMessage(targetPeer.ws, {
    type: 'signal',
    from: ws.peerId,
    data: msg.data
  });
}

function handleKick(ws, msg) {
  const peer = peers.get(ws.peerId);
  if (!peer) return;
  
  const roomId = msg.room;
  const room = rooms.get(roomId);
  
  if (!room || room.host !== ws.peerId) {
    sendMessage(ws, { type: 'error', message: 'Not host' });
    return;
  }
  
  const kickId = msg.kick;
  const kickPeer = peers.get(kickId);
  
  if (!kickPeer) return;
  
  room.peers.delete(kickId);
  kickPeer.rooms.delete(roomId);
  
  console.log(`⚠️  ${kickPeer.alias} foi removido da sala ${roomId}`);
  
  // Notifica o peer kickado
  sendMessage(kickPeer.ws, {
    type: 'kicked',
    room: roomId
  });
  
  // Notifica outros
  broadcastToRoom(roomId, {
    type: 'peer-disconnect',
    id: kickId
  });
}

function handleLock(ws, msg) {
  const peer = peers.get(ws.peerId);
  if (!peer) return;
  
  const roomId = msg.room;
  const room = rooms.get(roomId);
  
  if (!room || room.host !== ws.peerId) {
    sendMessage(ws, { type: 'error', message: 'Not host' });
    return;
  }
  
  room.locked = msg.locked;
  
  console.log(`🔒 Sala ${roomId} ${room.locked ? 'trancada' : 'destrancada'}`);
  
  broadcastToRoom(roomId, {
    type: 'lock',
    room: roomId,
    locked: room.locked
  });
}

// ============================================
// WEBSOCKET CONNECTION
// ============================================

wss.on('connection', (ws, req) => {
  ws.peerId = generateId();
  
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`🔌 Nova conexão: ${ws.peerId} de ${ip}`);
  
  // Ping/pong para manter conexão viva
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case 'login':
          handleLogin(ws, msg);
          break;
        case 'join':
          handleJoin(ws, msg);
          break;
        case 'leave':
          handleLeave(ws, msg);
          break;
        case 'signal':
          handleSignal(ws, msg);
          break;
        case 'kick':
          handleKick(ws, msg);
          break;
        case 'lock':
          handleLock(ws, msg);
          break;
        default:
          console.log(`⚠️  Mensagem desconhecida: ${msg.type}`);
      }
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
    }
  });
  
  ws.on('close', () => {
    console.log(`❌ Desconectado: ${ws.peerId}`);
    cleanupPeer(ws);
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// ============================================
// PING/PONG HEARTBEAT
// ============================================

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      console.log(`💀 Timeout: ${ws.peerId}`);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, config.ping_interval);

// ============================================
// LIMPEZA DE SALAS ANTIGAS
// ============================================

const cleanup = setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    if (now - room.created > config.room_timeout) {
      console.log(`🧹 Limpando sala antiga: ${roomId}`);
      rooms.delete(roomId);
    }
  });
}, 60000); // A cada 1 minuto

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM recebido, fechando servidor...');
  clearInterval(heartbeat);
  clearInterval(cleanup);
  
  wss.clients.forEach(ws => {
    ws.close(1000, 'Server shutting down');
  });
  
  server.close(() => {
    console.log('✅ Servidor fechado');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('⚠️  SIGINT recebido, fechando servidor...');
  process.exit(0);
});

// ============================================
// INICIA SERVIDOR
// ============================================

server.listen(config.server_port, config.server_host, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║  Construct 3 Signalling Server v1.0   ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log(`🚀 Servidor rodando em ${config.server_host}:${config.server_port}`);
  console.log(`📡 WebSocket: ${config.ssl_key_file ? 'wss' : 'ws'}://${config.server_host}:${config.server_port}`);
  console.log(`🌐 HTTP: http://${config.server_host}:${config.server_port}`);
  console.log('');
  console.log(`📊 Max Rooms: ${config.max_rooms}`);
  console.log(`👥 Max Peers/Room: ${config.max_peers_per_room}`);
  console.log('');
  console.log('Aguardando conexões...');
  console.log('');
});