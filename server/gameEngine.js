'use strict';

const {
  PHASE_CONFIG,
  PHASE_RECRUITMENT,
  PHASE_ACTION,
  PHASE_RESOLUTION,
  PHASE_SUMMARY,
  PHASE_END,
} = require('./phases');

const commands = require('./commands');
const { generateMap } = require('./mapTemplates');
const { resolveAlliances } = require('./rules/alliances');
const { resolveSpecialAbilities } = require('./rules/specialAbilities');
const { resolveCombat } = require('./rules/combat');
const { resolveIndustry } = require('./rules/industry');
const { resolveExpansion } = require('./rules/expansion');
const { factionByNumber } = require('./rules/territory');

const {
  ACTION_JOIN_FACTION,
  ACTION_ATTACK,
  ACTION_ALLIANCE,
  ACTION_DEFEND,
  VALID_PHASE_BY_ACTION,
} = commands;

const SUMMARY_MS_PER_BLOCK = 12000; // 10-15s por bloque, ver docs/GDD seccion 5

let match = null; // unica partida activa a la vez (ver docs/GDD "Alcance de v1")
let onStateChangeCallback = null;

// Registro de los ultimos comandos de chat RECONOCIDOS (aceptados o
// rechazados) que ha visto el motor, para que el panel de admin pueda ver
// justo por que un !faccion1 no hizo nada sin tener que mirar los logs del
// servidor — no depende de `match`, sobrevive a crear partidas nuevas. Solo
// se registran comandos reconocidos (ver parseCommand): el chat normal no
// entra aqui, seria ruido. Ver docs/ACCIONES.md.
const MAX_CHAT_LOG = 15;
let recentChatLog = [];

function pushChatLog(entry) {
  recentChatLog = [{ time: Date.now(), ...entry }, ...recentChatLog].slice(0, MAX_CHAT_LOG);
}

/** El servidor WS se suscribe aqui para retransmitir el estado cada vez que cambia algo. */
function setStateChangeListener(fn) {
  onStateChangeCallback = fn;
}

function notifyStateChange() {
  if (onStateChangeCallback) onStateChangeCallback();
}

// ---------------------------------------------------------------------------
// Fase 0 / arranque
// ---------------------------------------------------------------------------

function createMatch(config) {
  const normalizedConfig = normalizeConfig(config);
  const factions = normalizedConfig.factions.map((f, index) => ({
    id: index + 1,
    number: index + 1,
    name: f.name,
    color: f.color,
    industry: 0,
    industryGainedLastRound: 0,
    industryTierIndex: 0,
    industryPenaltyNextRound: false, // armado por Sabotaje esta ronda, se activa en la siguiente
    industryPenaltyActive: false, // Sabotaje activo ESTA ronda (armado la ronda anterior)
    specialEnabled: !!f.specialEnabled,
    specialAbility: f.specialAbility || null,
    specialUsed: false,
    territoryIds: [],
    killsCaused: 0,
  }));

  const { tiles, mapLayout } = generateMap({
    tileCount: normalizedConfig.map.tileCount,
    factionCount: factions.length,
    mode: normalizedConfig.map.mode,
  });

  for (const tile of tiles) {
    if (tile.ownerFactionNumber != null) {
      findInFactionList(factions, tile.ownerFactionNumber).territoryIds.push(tile.id);
    }
  }

  match = {
    phase: PHASE_CONFIG,
    config: normalizedConfig,
    factions,
    tiles,
    mapLayout, // estatico durante toda la partida, ver getMapLayout() y docs/ACCIONES.md
    players: new Map(),
    round: 0,
    roundActions: new Map(),
    lastAttackerOf: {},
    activeAlliancePairsThisRound: new Set(),
    combatModifiers: {},
    summaryBlocks: [],
    winnerFactionNumber: null,
    timer: null,
  };

  notifyStateChange();
  return getAdminState();
}

function normalizeConfig(config) {
  return {
    factions: config.factions,
    channels: config.channels || [],
    map: { tileCount: config.map?.tileCount ?? 20, mode: config.map?.mode ?? 'neutral' },
    alliancesEnabled: !!config.alliancesEnabled,
    thresholds: {
      expandPercent: config.thresholds?.expandPercent ?? 25,
      alliancePercent: config.thresholds?.alliancePercent ?? 50,
      specialPercent: config.thresholds?.specialPercent ?? 75,
    },
    timers: {
      recruitmentMs: config.timers?.recruitmentMs ?? 3 * 60 * 1000,
      actionMs: config.timers?.actionMs ?? 60 * 1000,
    },
  };
}

function startMatch() {
  assertPhase(PHASE_CONFIG);
  match.phase = PHASE_RECRUITMENT;
  startTimer(match.config.timers.recruitmentMs, closeRecruitment);
  notifyStateChange();
}

// ---------------------------------------------------------------------------
// Entrada unica de comandos de chat
// ---------------------------------------------------------------------------

function handleChatCommand(userId, username, channel, text) {
  if (!match) {
    console.log(`[gameEngine] "${text}" de ${username} ignorado: no hay ninguna partida creada todavia`);
    return;
  }

  const parsed = commands.parseCommand(text);
  if (!parsed) return; // no es un comando del juego, se ignora sin mas (no hace falta avisar)

  const requiredPhase = VALID_PHASE_BY_ACTION[parsed.type];
  if (match.phase !== requiredPhase) {
    const msg = `fase incorrecta (hace falta "${requiredPhase}", la partida esta en "${match.phase}")`;
    console.log(`[gameEngine] "${text}" de ${username} ignorado: ${msg}`);
    pushChatLog({ username, text, ok: false, reason: msg });
    return;
  }

  if (parsed.type === ACTION_JOIN_FACTION) {
    const ok = joinFaction(userId, username, parsed.targetFactionNumber);
    console.log(`[gameEngine] ${username} -> facción ${parsed.targetFactionNumber}: ${ok ? 'OK' : 'RECHAZADO (numero de facción invalido)'}`);
    pushChatLog({ username, text, ok, reason: ok ? `unido a la facción ${parsed.targetFactionNumber}` : 'número de facción inválido' });
    return;
  }

  const ok = castAction(userId, parsed.type, parsed.targetFactionNumber);
  console.log(`[gameEngine] ${username} -> ${parsed.type}: ${ok ? 'OK' : 'RECHAZADO (revisa si esta unido y vivo)'}`);
  pushChatLog({ username, text, ok, reason: ok ? 'aceptado' : 'rechazado (revisa si está unido a una facción y vivo)' });
}

function joinFaction(userId, username, factionNumber) {
  assertPhase(PHASE_RECRUITMENT);
  const faction = factionByNumber(match, factionNumber);
  if (!faction) return false;

  const existing = match.players.get(userId);
  match.players.set(userId, {
    userId,
    username,
    factionNumber,
    alive: true,
    unitType: existing ? existing.unitType : 'soldier',
    participation: existing ? existing.participation : 0,
    diedOnRound: null,
  });
  notifyStateChange();
  return true;
}

function castAction(userId, actionType, targetFactionNumber) {
  if (match.phase !== PHASE_ACTION) return false;
  const player = match.players.get(userId);
  if (!player || !player.alive) return false;

  if (actionType === commands.ACTION_EXPAND && match.config.map.mode === 'total') return false;
  if (actionType === ACTION_ALLIANCE && !match.config.alliancesEnabled) return false;

  if (actionType === ACTION_ATTACK || actionType === ACTION_ALLIANCE) {
    if (!targetFactionNumber || targetFactionNumber === player.factionNumber) return false;
    const target = factionByNumber(match, targetFactionNumber);
    if (!target || target.territoryIds.length === 0) return false;
  }

  match.roundActions.set(userId, { type: actionType, targetFactionNumber });
  notifyStateChange();
  return true;
}

// ---------------------------------------------------------------------------
// Transiciones de fase
// ---------------------------------------------------------------------------

function closeRecruitment() {
  assertPhase(PHASE_RECRUITMENT);
  match.phase = PHASE_ACTION;
  match.round = 1;
  match.roundActions.clear();
  startTimer(match.config.timers.actionMs, closeActionPhase);
  notifyStateChange();
}

function closeActionPhase() {
  assertPhase(PHASE_ACTION);
  clearTimer();
  match.phase = PHASE_RESOLUTION;
  resolveRound();
}

function resolveRound() {
  const context = tallyActions();

  // El Sabotaje lanzado en una ronda penaliza la industria de la RONDA
  // SIGUIENTE (ver docs/GDD seccion 11 "Sabotaje"), no la ronda en que se
  // lanza. Por eso el flag que arma resolveSpecialAbilities() de esta misma
  // llamada (industryPenaltyNextRound) no debe leerse todavia: primero se
  // "activa" aqui lo que quedo armado la ronda anterior, y solo despues se
  // deja que resolveSpecialAbilities() pueda armar un sabotaje nuevo para la
  // ronda que viene.
  for (const faction of match.factions) {
    faction.industryPenaltyActive = faction.industryPenaltyNextRound;
    faction.industryPenaltyNextRound = false;
  }

  resolveAlliances(match, context);
  resolveSpecialAbilities(match, context);
  context.allInactiveUserIds = new Set([...context.inactiveUserIds, ...context.forceInactive]);
  resolveCombat(match, context);
  resolveIndustry(match, context);
  resolveExpansion(match, context);

  match.summaryBlocks = buildRoundSummary(context);
  match.phase = PHASE_SUMMARY;
  startTimer(Math.max(match.summaryBlocks.length, 1) * SUMMARY_MS_PER_BLOCK, advanceRound);
  notifyStateChange();
}

function advanceRound() {
  assertPhase(PHASE_SUMMARY);
  const winner = checkVictory();
  if (winner) {
    match.phase = PHASE_END;
    match.winnerFactionNumber = winner.number;
    clearTimer();
    notifyStateChange();
    return;
  }

  match.round += 1;
  match.roundActions.clear();
  match.phase = PHASE_ACTION;
  startTimer(match.config.timers.actionMs, closeActionPhase);
  notifyStateChange();
}

function checkVictory() {
  const alive = match.factions.filter((f) => f.territoryIds.length > 0);
  return alive.length === 1 ? alive[0] : null;
}

// ---------------------------------------------------------------------------
// Recuento de votos de la ronda (contexto compartido por las reglas)
// ---------------------------------------------------------------------------

function tallyActions() {
  const votesByFactionAndType = new Map();
  const activePlayerCountByFaction = new Map();
  const inactiveUserIds = new Set();

  for (const faction of match.factions) {
    votesByFactionAndType.set(faction.number, {
      [commands.ACTION_INDUSTRY]: [],
      [ACTION_ATTACK]: new Map(),
      [ACTION_DEFEND]: [],
      [commands.ACTION_EXPAND]: [],
      [commands.ACTION_SPECIAL]: [],
      [ACTION_ALLIANCE]: new Map(),
    });
    activePlayerCountByFaction.set(faction.number, 0);
  }

  for (const player of match.players.values()) {
    if (!player.alive) continue;
    const bucket = votesByFactionAndType.get(player.factionNumber);
    if (!bucket) continue;
    activePlayerCountByFaction.set(player.factionNumber, activePlayerCountByFaction.get(player.factionNumber) + 1);

    const action = match.roundActions.get(player.userId);
    if (!action) {
      inactiveUserIds.add(player.userId);
      continue;
    }

    if (action.type === ACTION_ATTACK || action.type === ACTION_ALLIANCE) {
      const map = bucket[action.type];
      if (!map.has(action.targetFactionNumber)) map.set(action.targetFactionNumber, []);
      map.get(action.targetFactionNumber).push(player.userId);
    } else if (bucket[action.type]) {
      bucket[action.type].push(player.userId);
    }

    if (action.type === ACTION_ATTACK || action.type === ACTION_DEFEND) player.participation += 1;
  }

  return {
    votesByFactionAndType,
    activePlayerCountByFaction,
    inactiveUserIds,
    forceInactive: new Set(),
    // Sucesos de la ronda que van llenando resolveExpansion/resolveCombat/resolveIndustry a medida
    // que ocurren, para poder construir despues el resumen por fases (ver docs/ACCIONES.md seccion 6).
    roundEvents: { conquests: [], combats: [], industryUnlocks: [], eliminations: [] },
  };
}

/**
 * Construye los bloques del popup de resumen de ronda, uno por tipo de suceso
 * QUE DE VERDAD OCURRIO — un bloque sin nada que contar no se incluye, tanto
 * para no hacerle leer a nadie "Sin novedades" cinco veces seguidas como para
 * que la duracion de la fase de resumen (`SUMMARY_MS_PER_BLOCK` por bloque,
 * ver resolveRound()) escale con lo que de verdad paso en la ronda en vez de
 * ser siempre fija. Cada bloque es { kind, data }; ver docs/ACCIONES.md
 * seccion 6 para la forma exacta de `data` de cada kind. No contiene logica
 * de reglas, solo lee lo que las funciones de resolveRound() ya dejaron en
 * `context.roundEvents` y en los campos de cada faccion/jugador.
 */
function buildRoundSummary(context) {
  const blocks = [];

  const industryData = match.factions.map((f) => ({ faction: f.number, industry: f.industry, gained: f.industryGainedLastRound }));
  if (industryData.some((d) => d.gained > 0)) blocks.push({ kind: 'industry', data: industryData });

  if (context.roundEvents.conquests.length > 0) blocks.push({ kind: 'conquests', data: context.roundEvents.conquests });
  if (context.roundEvents.combats.length > 0) blocks.push({ kind: 'combats', data: context.roundEvents.combats });
  if (context.roundEvents.industryUnlocks.length > 0) blocks.push({ kind: 'industryUnlocks', data: context.roundEvents.industryUnlocks });
  if (context.roundEvents.eliminations.length > 0) blocks.push({ kind: 'eliminations', data: context.roundEvents.eliminations });

  const casualties = [...match.players.values()]
    .filter((p) => p.diedOnRound === match.round)
    .map((p) => ({ username: p.username, factionNumber: p.factionNumber }));
  if (casualties.length > 0) blocks.push({ kind: 'casualties', data: casualties });

  return blocks;
}

// ---------------------------------------------------------------------------
// Timer (usado tanto por las fases automaticas como por los controles admin)
// ---------------------------------------------------------------------------

function startTimer(durationMs, onExpire) {
  clearTimer();
  match.timer = {
    endsAt: Date.now() + durationMs,
    remainingMs: durationMs,
    paused: false,
    onExpire,
    handle: setTimeout(onExpire, durationMs),
  };
}

function clearTimer() {
  if (match?.timer?.handle) clearTimeout(match.timer.handle);
}

function pauseTimer() {
  if (!match?.timer || match.timer.paused) return;
  clearTimeout(match.timer.handle);
  match.timer.remainingMs = match.timer.endsAt - Date.now();
  match.timer.paused = true;
  notifyStateChange();
}

function resumeTimer() {
  if (!match?.timer || !match.timer.paused) return;
  match.timer.paused = false;
  match.timer.endsAt = Date.now() + match.timer.remainingMs;
  match.timer.handle = setTimeout(match.timer.onExpire, match.timer.remainingMs);
  notifyStateChange();
}

function forceAdvancePhase() {
  if (!match?.timer) return;
  clearTimeout(match.timer.handle);
  match.timer.onExpire();
}

function endMatch() {
  clearTimer();
  if (match) match.phase = PHASE_END;
  notifyStateChange();
}

// ---------------------------------------------------------------------------
// Estado publico / admin
// ---------------------------------------------------------------------------

function getPublicState() {
  // Nunca `null`: un espectador puede conectarse a la web pública ANTES de
  // que el admin cree la primera partida (server/index.js manda este estado
  // nada más conectar) — `render()` en public/index.html hace `state.phase`
  // sin comprobar `state` primero, así que un `null` aquí lo hacía crashear
  // en cuanto se abría la web pública sin partida creada todavía. Mismo
  // criterio que `getAdminState()`, que ya devolvía un objeto por defecto en
  // vez de `null` para este mismo caso.
  if (!match) {
    return {
      phase: null,
      round: 0,
      factions: [],
      tiles: [],
      players: [],
      summaryBlocks: [],
      winnerFactionNumber: null,
      timerEndsAt: null,
      timerPaused: false,
    };
  }
  return {
    phase: match.phase,
    round: match.round,
    factions: match.factions.map((f) => ({
      number: f.number,
      name: f.name,
      color: f.color,
      industry: f.industry,
      industryGainedLastRound: f.industryGainedLastRound,
      territoryCount: f.territoryIds.length,
      killsCaused: f.killsCaused,
      wondersCount: 0, // reservado para v2 (maravillas), ver docs/GDD "Alcance de v1 vs futuro"
    })),
    tiles: match.tiles.map((t) => ({ id: t.id, ownerFactionNumber: t.ownerFactionNumber, neutral: t.neutral })),
    players: [...match.players.values()].map((p) => ({
      userId: p.userId,
      username: p.username,
      factionNumber: p.factionNumber,
      alive: p.alive,
      unitType: p.unitType,
    })),
    summaryBlocks: match.phase === PHASE_SUMMARY ? match.summaryBlocks : [],
    winnerFactionNumber: match.winnerFactionNumber,
    timerEndsAt: match.timer?.endsAt ?? null,
    // En pausa, `timerEndsAt` se queda congelado en el instante en que se
    // pausó (ver pauseTimer()) — sin esto ningun cliente sabe que ese valor
    // ya no cuenta y la cuenta atras se ve caer a 00:00 sola. Va en el
    // estado público (no solo en el de admin) porque también hace falta en
    // la web pública para congelar su propia cuenta atrás — ver
    // `public/matchTimer.js` y docs/ACCIONES.md.
    timerPaused: !!match.timer?.paused,
  };
}

function getAdminState() {
  // `getPublicState()` ya devuelve la forma completa por defecto sin partida
  // creada (ver comentario ahí) — aquí solo hace falta añadir lo propio del
  // admin encima, sin repetir ese objeto por defecto una segunda vez.
  return { ...getPublicState(), config: match ? match.config : null, chatLog: recentChatLog };
}

/**
 * Geometria estatica del mapa (rejilla raster + que tile posee cada celda),
 * igual para la web publica y el panel de admin. No cambia durante la partida,
 * asi que se manda una unica vez (mensaje `map:layout`, ver docs/ACCIONES.md
 * seccion 5) en vez de ir dentro de cada `state:public`/`state:admin`.
 */
function getMapLayout() {
  return match?.mapLayout ?? null;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Busca una faccion por numero dentro de un array de facciones suelto (usado solo en createMatch,
 * antes de que exista `match`). Para cualquier otro caso, usar `factionByNumber(match, number)`
 * importado de `rules/territory.js` — es la unica fuente de verdad para esa busqueda.
 */
function findInFactionList(factions, number) {
  return factions.find((f) => f.number === number);
}

function assertPhase(expectedPhase) {
  if (!match || match.phase !== expectedPhase) {
    throw new Error(`Operacion invalida: se esperaba fase "${expectedPhase}", fase actual "${match?.phase}"`);
  }
}

module.exports = {
  setStateChangeListener,
  createMatch,
  startMatch,
  handleChatCommand,
  joinFaction,
  closeRecruitment,
  castAction,
  closeActionPhase,
  resolveRound,
  advanceRound,
  checkVictory,
  pauseTimer,
  resumeTimer,
  forceAdvancePhase,
  endMatch,
  getPublicState,
  getAdminState,
  getMapLayout,
};
