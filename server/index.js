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
const mapLayoutCodec = require('./mapLayoutCodec');
const { createServer } = require('./lib/miniWsServer');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'condejorge-demo';

let pendingChannels = [];
let botConnected = false;
// Texto JSON del ultimo `map:layout` ya listo para mandar (con `cellTileIds`
// empaquetado, ver mapLayoutCodec.js) — se recalcula SOLO cuando se crea una
// partida nueva, asi que un espectador nuevo conectandose durante la partida
// (wsApp.onConnect) no repite el empaquetado/base64 de ~10MB cada vez.
let cachedMapLayoutMessage = null;

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
 *
 * `cellTileIds` (un id de tile por cada una de las ~10M celdas del raster) NO
 * se manda como array JSON plano — a la resolucion actual eso pesaria ~27,5MB
 * por mensaje. Se empaqueta primero con `mapLayoutCodec.encodeCellTileIds()`
 * (1-2 bytes/celda + base64, ver ese archivo para el formato exacto) — el
 * cliente lo desempaqueta en `public/mapRenderer.js` `decodeCellTileIds()`.
 * Ver docs/ACCIONES.md seccion 6.
 */
function buildWireMapLayout(layout) {
  const tileCount = layout.centroids.length; // un centroide por tile, ver mapTemplates.js
  const cellTileIdsPacked = mapLayoutCodec.encodeCellTileIds(layout.cellTileIds, tileCount);
  return { cols: layout.cols, rows: layout.rows, centroids: layout.centroids, cellTileIdsPacked };
}

function broadcastMapLayout() {
  const layout = engine.getMapLayout();
  if (!layout) {
    cachedMapLayoutMessage = null;
    return;
  }
  cachedMapLayoutMessage = JSON.stringify({ type: 'map:layout', payload: buildWireMapLayout(layout) });
  wsApp.broadcast(cachedMapLayoutMessage, 'public');
  wsApp.broadcast(cachedMapLayoutMessage, 'admin');
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
  // primer pintado no tenga que esperar a un segundo mensaje. Se reutiliza el
  // mensaje ya empaquetado (`cachedMapLayoutMessage`) en vez de volver a
  // codificar `cellTileIds` para cada cliente nuevo que se conecta.
  if (cachedMapLayoutMessage) wsApp.send(client, cachedMapLayoutMessage);

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
