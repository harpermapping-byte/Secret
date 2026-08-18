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
        broadcastMapLayout();
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

/**
 * La geometria del mapa (rejilla raster) es estatica durante toda la partida,
 * asi que se manda una unica vez por este mensaje aparte en vez de repetirla
 * en cada `state:public`/`state:admin` (ver docs/ACCIONES.md seccion 5).
 */
function broadcastMapLayout() {
  const layout = engine.getMapLayout();
  if (!layout) return;
  const text = JSON.stringify({ type: 'map:layout', payload: layout });
  wsApp.broadcast(text, 'public');
  wsApp.broadcast(text, 'admin');
}

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

/**
 * El estado de admin combina el estado de partida del motor con el estado de
 * conexion del bot de Twitch (que vive aparte, en twitchBot.js, porque no
 * depende de que haya una partida creada) — asi el panel de admin puede ver
 * de un vistazo si el bot esta realmente conectado/unido al canal, sin lo
 * cual un fallo de conexion es invisible (solo se veria que "!faccion1" no
 * hace nada). Ver docs/ACCIONES.md.
 */
function buildAdminState() {
  return { ...engine.getAdminState(), botStatus: twitchBot.getStatus() };
}

function broadcastAdminState() {
  wsApp.broadcast(JSON.stringify({ type: 'state:admin', payload: buildAdminState() }), 'admin');
}

engine.setStateChangeListener(() => {
  wsApp.broadcast(JSON.stringify({ type: 'state:public', payload: engine.getPublicState() }), 'public');
  broadcastAdminState();
});

// El estado del bot cambia de forma independiente al estado de la partida
// (conectando, reconectando, error, union a canal confirmada...), asi que
// necesita su propio disparador de broadcast en vez de esperar al siguiente
// cambio de partida.
twitchBot.onStatusChange(() => {
  broadcastAdminState();
});

wsApp.onConnect((client) => {
  // La geometria del mapa se manda antes que el estado (aunque el cliente ya
  // no depende estrictamente de este orden, ver mapRenderer.js) para que el
  // primer pintado no tenga que esperar a un segundo mensaje.
  const layout = engine.getMapLayout();
  if (layout) wsApp.send(client, JSON.stringify({ type: 'map:layout', payload: layout }));

  if (client.role === 'admin') {
    wsApp.send(client, JSON.stringify({ type: 'state:admin', payload: buildAdminState() }));
  } else {
    wsApp.send(client, JSON.stringify({ type: 'state:public', payload: engine.getPublicState() }));
  }
});

wsApp.server.listen(PORT, () => {
  console.log(`Condejorge Wars escuchando en http://localhost:${PORT}`);
  console.log(`Panel admin: http://localhost:${PORT}/admin (contraseña: ${ADMIN_PASSWORD})`);
});
