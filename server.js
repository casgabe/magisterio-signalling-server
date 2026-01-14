// ============================================
// Construct 2/3 Signalling Server  
// Baseado no servidor oficial da Scirra
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
  
  // SSL (deixe null se não tiver certificado)
  ssl_key_file: null,
  ssl_cert_file: null,
  
  // STUN servers para WebRTC
  ice_servers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],
  
  max_rooms: 1000,
  max_peers_per_room: 4
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
} else {
  server = http.createServer(handleHTTP);
}

function handleHTTP(req, res) {
  const roomCount = Object.keys(rooms).length;
  const peerCount = Object.keys(peers).length;
  
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <html>
    <head><title>Construct Signalling Server</title></head>
    <body style="font-family:Arial;padding:20px;background:#1a1a2e;color:#eee;">
      <h1>✅ Construct 2/3 Signalling Server</h1>
      <p>Active Connections: ${peerCount}</p>
      <p>Active Rooms: ${roomCount}</p>
      <p>Uptime: ${Math.floor(process.uptime())}s</p>
      <p>Server Time: ${new Date().toISOString()}</p>
    </body>
    </html>
  `);
}

// ============================================
// WEBSOCKET SERVER
// ============================================
const wss = new WebSocket.Server({ 
  server: server,
  perMessageDeflate: false
});

// ============================================
// ESTRUTURAS DE DADOS
// ============================================
const rooms = {}; // { roomName: { host: peerId, locked: bool, peers: [] } }
const peers = {}; // { peerId: { ws, alias, rooms: [] } }

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

function generatePeerId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function sendToPeer(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const json = JSON.stringify(msg);
    ws.send(json);
    console.log(`→ Enviando para peer:`, JSON.stringify(msg, null, 2));
  }
}

function broadcastToRoom(roomName, msg, excludeWs = null) {
  const room = rooms[roomName];
  if (!room) return;
  
  room.peers.forEach(peerId => {
    const peer = peers[peerId];
    if (peer && peer.ws !== excludeWs) {
      sendToPeer(peer.ws, msg);
    }
  });
}

// ============================================
// HANDLERS DE MENSAGENS
// ============================================

function handleLogin(ws, msg) {
  const peerId = msg.id || generatePeerId();
  const alias = msg.alias || 'Anonymous';
  
  ws.peerId = peerId;
  
  peers[peerId] = {
    ws: ws,
    alias: alias,
    rooms: []
  };
  
  console.log(`✅ LOGIN: ${alias} (${peerId})`);
  
  // Responde com login bem-sucedido
  sendToPeer(ws, {
    type: 'login',
    id: peerId,
    ice_servers: config.ice_servers
  });
}

function handleJoin(ws, msg) {
  const peerId = ws.peerId;
  const peer = peers[peerId];
  
  if (!peer) {
    console.log(`❌ Peer ${peerId} não está logado`);
    return;
  }
  
  const roomName = msg.room;
  let room = rooms[roomName];
  
  // Cria sala se não existe
  if (!room) {
    if (Object.keys(rooms).length >= config.max_rooms) {
      sendToPeer(ws, { type: 'error', message: 'Server full' });
      return;
    }
    
    room = {
      host: peerId,
      locked: false,
      peers: []
    };
    rooms[roomName] = room;
    console.log(`🏠 Sala criada: "${roomName}" por ${peer.alias}`);
  }
  
  // Verifica se a sala está cheia
  if (room.peers.length >= config.max_peers_per_room) {
    sendToPeer(ws, { type: 'error', message: 'Room full' });
    return;
  }
  
  // Verifica se a sala está trancada
  if (room.locked && room.host !== peerId) {
    sendToPeer(ws, { type: 'error', message: 'Room locked' });
    return;
  }
  
  // Adiciona peer à sala
  room.peers.push(peerId);
  peer.rooms.push(roomName);
  
  const isHost = (room.host === peerId);
  
  console.log(`👥 ${peer.alias} entrou em "${roomName}" ${isHost ? '(HOST)' : '(PEER)'}`);
  
  // Envia confirmação ao peer que entrou
  sendToPeer(ws, {
    type: 'join',
    room: roomName,
    id: peerId,
    host: isHost
  });
  
  // Notifica outros peers na sala
  broadcastToRoom(roomName, {
    type: 'peer-connect',
    id: peerId,
    alias: peer.alias
  }, ws);
}

function handleLeave(ws, msg) {
  const peerId = ws.peerId;
  const peer = peers[peerId];
  
  if (!peer) return;
  
  const roomName = msg.room;
  const room = rooms[roomName];
  
  if (!room) return;
  
  // Remove peer da sala
  const idx = room.peers.indexOf(peerId);
  if (idx !== -1) {
    room.peers.splice(idx, 1);
  }
  
  const idx2 = peer.rooms.indexOf(roomName);
  if (idx2 !== -1) {
    peer.rooms.splice(idx2, 1);
  }
  
  console.log(`👋 ${peer.alias} saiu de "${roomName}"`);
  
  // Notifica outros peers
  broadcastToRoom(roomName, {
    type: 'peer-disconnect',
    id: peerId
  });
  
  // Remove sala se vazia ou se o host saiu
  if (room.peers.length === 0 || room.host === peerId) {
    delete rooms[roomName];
    console.log(`🗑️  Sala removida: "${roomName}"`);
  }
  
  sendToPeer(ws, {
    type: 'leave',
    room: roomName
  });
}

function handleSignal(ws, msg) {
  const targetId = msg.to;
  const targetPeer = peers[targetId];
  
  if (!targetPeer) {
    console.log(`❌ Peer alvo ${targetId} não encontrado`);
    return;
  }
  
  // Encaminha sinal WebRTC
  sendToPeer(targetPeer.ws, {
    type: 'signal',
    from: ws.peerId,
    data: msg.data
  });
}

function handleKick(ws, msg) {
  const peerId = ws.peerId;
  const peer = peers[peerId];
  
  if (!peer) return;
  
  const roomName = msg.room;
  const room = rooms[roomName];
  
  if (!room || room.host !== peerId) {
    sendToPeer(ws, { type: 'error', message: 'Not host' });
    return;
  }
  
  const kickId = msg.kick;
  const kickPeer = peers[kickId];
  
  if (!kickPeer) return;
  
  // Remove peer da sala
  const idx = room.peers.indexOf(kickId);
  if (idx !== -1) {
    room.peers.splice(idx, 1);
  }
  
  const idx2 = kickPeer.rooms.indexOf(roomName);
  if (idx2 !== -1) {
    kickPeer.rooms.splice(idx2, 1);
  }
  
  console.log(`⚠️  ${kickPeer.alias} removido de "${roomName}"`);
  
  // Notifica o peer kickado
  sendToPeer(kickPeer.ws, {
    type: 'kicked',
    room: roomName
  });
  
  // Notifica outros peers
  broadcastToRoom(roomName, {
    type: 'peer-disconnect',
    id: kickId
  });
}

function handleLock(ws, msg) {
  const peerId = ws.peerId;
  const peer = peers[peerId];
  
  if (!peer) return;
  
  const roomName = msg.room;
  const room = rooms[roomName];
  
  if (!room || room.host !== peerId) {
    sendToPeer(ws, { type: 'error', message: 'Not host' });
    return;
  }
  
  room.locked = msg.locked;
  
  console.log(`🔒 Sala "${roomName}" ${room.locked ? 'trancada' : 'destrancada'}`);
  
  broadcastToRoom(roomName, {
    type: 'lock',
    room: roomName,
    locked: room.locked
  });
}

// ============================================
// CONEXÃO WEBSOCKET
// ============================================

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`\n🔌 Nova conexão de ${ip}`);
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`← Recebido:`, JSON.stringify(msg, null, 2));
      
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
          console.log(`⚠️  Tipo de mensagem desconhecido: ${msg.type}`);
          // NÃO envia erro de volta, apenas ignora
      }
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
    }
  });
  
  ws.on('close', () => {
    const peerId = ws.peerId;
    const peer = peers[peerId];
    
    if (peer) {
      console.log(`❌ Desconectado: ${peer.alias} (${peerId})`);
      
      // Remove de todas as salas
      peer.rooms.forEach(roomName => {
        const room = rooms[roomName];
        if (room) {
          const idx = room.peers.indexOf(peerId);
          if (idx !== -1) {
            room.peers.splice(idx, 1);
          }
          
          broadcastToRoom(roomName, {
            type: 'peer-disconnect',
            id: peerId
          });
          
          if (room.peers.length === 0 || room.host === peerId) {
            delete rooms[roomName];
            console.log(`🗑️  Sala removida: "${roomName}"`);
          }
        }
      });
      
      delete peers[peerId];
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// ============================================
// INICIA SERVIDOR
// ============================================

server.listen(config.server_port, config.server_host, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  Construct 2/3 Signalling Server     ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
  console.log(`🚀 Servidor: ${config.server_host}:${config.server_port}`);
  console.log(`📡 WebSocket: ${config.ssl_key_file ? 'wss' : 'ws'}://${config.server_host}:${config.server_port}`);
  console.log('');
  console.log('Aguardando conexões...');
  console.log('');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', () => {
  console.log('⚠️  Encerrando servidor...');
  wss.clients.forEach(ws => ws.close());
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});