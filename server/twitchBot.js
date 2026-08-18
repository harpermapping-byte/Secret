'use strict';

// Bot de lectura de chat de Twitch, multicanal, sin dependencias externas.
// Usa el WebSocket global nativo de Node (WHATWG WebSocket, disponible desde
// Node 22) para hablar el protocolo IRC de Twitch directamente.
// Ver docs/ACCIONES.md seccion 4.
//
// Login anonimo (solo lectura, sin cuenta de bot): PASS <cualquier valor> +
// NICK justinfan<numero al azar>. No requiere credenciales de los streamers
// cuyos canales se escuchan, ni que esten en directo.

const IRC_WS_URL = 'wss://irc-ws.chat.twitch.tv:443';
const PING_INTERVAL_MS = 4 * 60 * 1000;

let socket = null;
let onCommandCallback = null;

/**
 * Estado de conexion, expuesto via getStatus() para que el panel de admin
 * pueda ver de un vistazo si el bot esta conectado de verdad, a que canales
 * se unio, y cuando vio el ultimo mensaje de chat (aunque no sea un comando
 * del juego) — sin eso, un fallo de conexion es invisible para el admin,
 * que solo veria que "!faccion1" no hace nada sin saber por que. Ver
 * docs/ACCIONES.md.
 * state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
 */
let status = { state: 'disconnected', channels: [], joinedChannels: [], lastError: null, lastMessageAt: null };
let onStatusChangeCallback = null;

function onStatusChange(fn) {
  onStatusChangeCallback = fn;
}

function setStatus(patch) {
  status = { ...status, ...patch };
  if (onStatusChangeCallback) onStatusChangeCallback(status);
}

function getStatus() {
  return status;
}

function connectToChannels(channelNames, onCommand) {
  onCommandCallback = onCommand;
  setStatus({ state: 'connecting', channels: channelNames, joinedChannels: [], lastError: null });

  // El WebSocket global (WHATWG) solo existe desde Node 22 — si alguien
  // arranca esto con un Node mas viejo, `new WebSocket(...)` explotaria con
  // un ReferenceError críptico. Lo comprobamos aqui para dar un error claro
  // y visible en el panel de admin en vez de un fallo silencioso.
  if (typeof WebSocket === 'undefined') {
    const msg = 'Este Node no tiene WebSocket global — hace falta Node 22 o superior (revisa "node -v")';
    console.error('[twitchBot]', msg);
    setStatus({ state: 'error', lastError: msg });
    return;
  }

  socket = new WebSocket(IRC_WS_URL);

  socket.addEventListener('open', () => {
    console.log('[twitchBot] conectado a Twitch IRC, iniciando sesion anonima...');
    setStatus({ state: 'connected', lastError: null });
    const anonId = Math.floor(Math.random() * 100000);
    socket.send(`PASS ${randomToken()}`);
    socket.send(`NICK justinfan${anonId}`);
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    setTimeout(() => {
      channelNames.forEach((name) => {
        console.log(`[twitchBot] uniendose al chat de #${normalizeChannel(name)}...`);
        socket.send(`JOIN #${normalizeChannel(name)}`);
      });
    }, 500);
  });

  socket.addEventListener('message', (event) => {
    String(event.data)
      .split('\r\n')
      .filter(Boolean)
      .forEach(handleLine);
  });

  socket.addEventListener('close', () => {
    console.log('[twitchBot] conexion cerrada, reintentando en 5s...');
    setStatus({ state: 'reconnecting', joinedChannels: [] });
    setTimeout(() => connectToChannels(channelNames, onCommandCallback), 5000);
  });

  socket.addEventListener('error', (err) => {
    const msg = (err && err.message) || 'error de conexion desconocido (revisa que el servidor tenga salida a internet)';
    console.error('[twitchBot] error de conexion:', msg);
    setStatus({ state: 'error', lastError: msg });
  });

  const keepAlive = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send('PING :tmi.twitch.tv');
  }, PING_INTERVAL_MS);
  socket.addEventListener('close', () => clearInterval(keepAlive));
}

function handleLine(line) {
  const message = parseIrcLine(line);

  if (message.command === 'PING') {
    socket.send(`PONG :${message.params[0] || 'tmi.twitch.tv'}`);
    return;
  }

  if (message.command === '366') {
    // "End of /NAMES list": confirmacion de que la union al canal se completo.
    const channel = message.params[1];
    console.log(`[twitchBot] union confirmada a #${channel}, escuchando chat...`);
    setStatus({ joinedChannels: [...new Set([...status.joinedChannels, channel])] });
    return;
  }

  if (message.command === 'NOTICE') {
    const noticeText = message.params[message.params.length - 1];
    console.warn('[twitchBot] aviso de Twitch:', noticeText);
    setStatus({ lastError: `aviso de Twitch: ${noticeText}` });
    return;
  }

  if (message.command === 'PRIVMSG') {
    const channel = message.params[0].replace(/^#/, '');
    const text = message.params[1] || '';
    const userId = message.tags['user-id'];
    const username = message.tags['display-name'] || message.prefix?.split('!')[0] || 'desconocido';
    console.log(`[twitchBot] [#${channel}] ${username}: ${text}`);
    setStatus({ lastMessageAt: Date.now() });
    if (userId && onCommandCallback) onCommandCallback({ userId, username, channel, text });
  }
}

/** Parser minimo de una linea IRCv3: tags, prefix, comando y parametros. */
function parseIrcLine(rawLine) {
  let rest = rawLine;
  const tags = {};

  if (rest.startsWith('@')) {
    const spaceIndex = rest.indexOf(' ');
    rest
      .slice(1, spaceIndex)
      .split(';')
      .forEach((pair) => {
        const [key, value] = pair.split('=');
        tags[key] = value;
      });
    rest = rest.slice(spaceIndex + 1);
  }

  let prefix = null;
  if (rest.startsWith(':')) {
    const spaceIndex = rest.indexOf(' ');
    prefix = rest.slice(1, spaceIndex);
    rest = rest.slice(spaceIndex + 1);
  }

  const spaceIndex = rest.indexOf(' ');
  const command = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
  rest = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1);

  const params = [];
  while (rest.length > 0) {
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const nextSpace = rest.indexOf(' ');
    if (nextSpace === -1) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, nextSpace));
    rest = rest.slice(nextSpace + 1);
  }

  return { tags, prefix, command, params };
}

/**
 * Acepta cualquier forma en la que el admin pueda escribir el canal:
 * "condejorge", "#condejorge", "twitch.tv/condejorge" o la URL completa.
 */
function normalizeChannel(rawInput) {
  let value = rawInput.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '');
  value = value.replace(/^(www\.)?twitch\.tv\//, '');
  value = value.replace(/^#/, '');
  value = value.split('/')[0].split('?')[0]; // por si pegan la URL con algo detras (ej. /videos)
  return value;
}

function randomToken() {
  return Math.random().toString(36).slice(2);
}

module.exports = { connectToChannels, getStatus, onStatusChange };
