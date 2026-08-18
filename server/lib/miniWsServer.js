'use strict';

// Servidor HTTP + WebSocket minimo, sin dependencias externas (Node no trae
// un servidor WebSocket nativo, solo el cliente). Implementa el handshake de
// RFC 6455 y sirve archivos estaticos. Pensado solo para esta demo v1;
// si mas adelante se habilita npm, se puede sustituir por el paquete `ws`
// sin tocar gameEngine.js ni las reglas.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FrameReader, encodeText, encodeClose, encodePong, OPCODE_TEXT, OPCODE_CLOSE, OPCODE_PING } = require('./wsFrames');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(secWebSocketKey + WS_MAGIC).digest('base64');
}

/**
 * staticRoutes: [{ prefix: '/admin', dir: '/abs/path/admin' }, { prefix: '', dir: '/abs/path/public' }]
 * onWsUpgrade(req): devuelve { accept, role } para decidir si se acepta la conexion y con que rol.
 */
function createServer({ staticRoutes, onWsUpgrade }) {
  const clients = new Set();
  let onConnect = null;
  let onMessage = null;
  let onDisconnect = null;

  const server = http.createServer((req, res) => serveStatic(req, res, staticRoutes));

  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/ws') {
      socket.destroy();
      return;
    }

    const decision = onWsUpgrade(req) || { accept: false };
    if (!decision.accept) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`
    );

    const client = { socket, reader: new FrameReader(), role: decision.role };
    clients.add(client);

    if (head && head.length) handleIncomingData(client, head);
    socket.on('data', (chunk) => handleIncomingData(client, chunk));
    socket.on('close', () => {
      clients.delete(client);
      if (onDisconnect) onDisconnect(client);
    });
    socket.on('error', () => socket.destroy());

    if (onConnect) onConnect(client);
  });

  function handleIncomingData(client, chunk) {
    let messages;
    try {
      messages = client.reader.push(chunk);
    } catch {
      client.socket.destroy();
      return;
    }
    for (const msg of messages) {
      if (msg.opcode === OPCODE_TEXT && onMessage) {
        onMessage(client, msg.payload.toString('utf8'));
      } else if (msg.opcode === OPCODE_PING) {
        client.socket.write(encodePong(msg.payload));
      } else if (msg.opcode === OPCODE_CLOSE) {
        client.socket.end(encodeClose());
        clients.delete(client);
      }
    }
  }

  function send(client, text) {
    if (client.socket.writable) client.socket.write(encodeText(text));
  }

  function broadcast(text, roleFilter) {
    for (const client of clients) {
      if (roleFilter && client.role !== roleFilter) continue;
      send(client, text);
    }
  }

  return {
    server,
    onConnect: (fn) => (onConnect = fn),
    onMessage: (fn) => (onMessage = fn),
    onDisconnect: (fn) => (onDisconnect = fn),
    send,
    broadcast,
  };
}

function serveStatic(req, res, staticRoutes) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  for (const route of staticRoutes) {
    const matchesPrefix = urlPath === route.prefix || urlPath.startsWith(`${route.prefix}/`);
    if (!matchesPrefix) continue;

    let relativePath = urlPath.slice(route.prefix.length) || '/index.html';
    if (relativePath === '/') relativePath = '/index.html';

    // `path.relative` (en vez de `filePath.startsWith(route.dir)`) evita el
    // caso borde de un `startsWith` a pelo: un directorio hermano cuyo nombre
    // empiece igual que `route.dir` (p.ej. "admin-secrets" junto a "admin")
    // pasaria un startsWith aunque no sea el mismo directorio. Si la ruta
    // relativa se sale de `route.dir` (".." al principio) o es absoluta, es
    // que la peticion intenta escapar del directorio servido.
    const filePath = path.join(route.dir, relativePath);
    const relativeToRoot = path.relative(route.dir, filePath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      res.writeHead(403);
      res.end('Prohibido');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('No encontrado');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('No encontrado');
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.mp3')) return 'audio/mpeg'; // musica de fondo, ver public/audio/
  return 'application/octet-stream';
}

module.exports = { createServer };
