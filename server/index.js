'use strict';

// Punto de entrada: arranca el servidor HTTP+WS, conecta el motor de juego,
// y solo une el bot de Twitch a los canales configurados cuando el admin
// pulsa "Iniciar partida" (Fase 0 -> Fase de Reclutamiento).

// Solo tiene efecto si el sistema tiene configurado un proxy HTTP (variables
// de entorno http_proxy/https_proxy). Si no, no hace nada. Se pone aqui en
// vez de en el script de npm para que funcione igual en Windows, Mac y Linux.
process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';

const path = require('path');
const engine = require('./gameEngine');
const twitchBot = require('./twitchBot');
const { createServer } = require('./lib/miniWsServer');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'condejorge-demo';

let pendingChannels = [];
let botConnected = false;

const wsApp = createServer({
  staticRoutes: [
    { prefix: '/admin', dir: path.join(__dirname, '..', 'admin') },
    { prefix: '', dir: path.join(__dirname, '..', 'public') },
  ],
  onWsUpgrade: (req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role') === 'admin' ? 'admin' : 'public';
    if (role === 'admin' && url.searchParams.get('token') !== ADMIN_PASSWORD) {
      return { accept: false };
    }
    return { accept: true, role };
  },
});

wsApp.onMessage((client, rawText) => {
  if (client.role !== 'admin') return; // solo el panel admin puede mandar comandos, ver docs/ACCIONES.md seccion 5

  let message;
  try {
    message = JSON.parse(rawText);
  } catch {
    return;
  }

  console.log('[server] accion admin recibida:', message.type);

  try {
    switch (message.type) {
      case 'admin:createMatch':
        pendingChannels = message.payload.channels || [];
        engine.createMatch(message.payload);
        console.log('[server] partida creada, canales configurados:', pendingChannels);
        break;
      case 'admin:startMatch':
        engine.startMatch();
        connectBotOnce();
        break;
      case 'admin:pause':
        engine.pauseTimer();
        break;
      case 'admin:resume':
        engine.resumeTimer();
        break;
      case 'admin:advancePhase':
        engine.forceAdvancePhase();
        break;
      case 'admin:endMatch':
        engine.endMatch();
        break;
      default:
        console.warn('[server] mensaje admin desconocido:', message.type);
    }
  } catch (err) {
    console.error('[server] error procesando accion admin:', err.message);
  }
});

function connectBotOnce() {
  if (botConnected) {
    console.log('[server] el bot ya estaba conectado, no se vuelve a conectar');
    return;
  }
  if (pendingChannels.length === 0) {
    console.warn('[server] no hay canales configurados, el bot no se conecta a nada');
    return;
  }
  botConnected = true;
  console.log('[server] conectando el bot a:', pendingChannels);
  twitchBot.connectToChannels(pendingChannels, ({ userId, username, channel, text }) => {
    engine.handleChatCommand(userId, username, channel, text);
  });
}

engine.setStateChangeListener(() => {
  wsApp.broadcast(JSON.stringify({ type: 'state:public', payload: engine.getPublicState() }), 'public');
  wsApp.broadcast(JSON.stringify({ type: 'state:admin', payload: engine.getAdminState() }), 'admin');
});

wsApp.onConnect((client) => {
  const payload = client.role === 'admin' ? engine.getAdminState() : engine.getPublicState();
  wsApp.send(client, JSON.stringify({ type: client.role === 'admin' ? 'state:admin' : 'state:public', payload }));
});

wsApp.server.listen(PORT, () => {
  console.log(`Condejorge Wars escuchando en http://localhost:${PORT}`);
  console.log(`Panel admin: http://localhost:${PORT}/admin (contraseña: ${ADMIN_PASSWORD})`);
});
