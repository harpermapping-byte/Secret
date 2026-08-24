'use strict';

const {
  PHASE_CONFIG,
  PHASE_RECRUITMENT,
  PHASE_ACTION,
  PHASE_RESOLUTION,
  PHASE_SUMMARY,
  PHASE_TRANSITION,
  PHASE_END,
} = require('./phases');

const commands = require('./commands');
const { generateMap, DEFAULT_MAP_KEY } = require('./mapTemplates');
const { resolveAlliances } = require('./rules/alliances');
const { resolveSpecialAbilities } = require('./rules/specialAbilities');
const { resolveCombat } = require('./rules/combat');
const { resolveIndustry, industryThresholdsFor } = require('./rules/industry');
const { resolveAiTroops } = require('./rules/troops');
const { resolveTroopBuildings } = require('./rules/troopBuildings');
const { resolveConquista, resolveDungeon, structureAttackPower, structureDefensePower } = require('./rules/structures');
const { resolveTowers, towerDefenseBonus } = require('./rules/towers');
const { resolveBoss, museumDefenseBonus } = require('./rules/bosses');
const { resolveCasas } = require('./rules/housing');
const { wonderDefenseBonus } = require('./rules/wonders');
const {
  AI_TROOP_COMBAT_BONUS,
  ARCHER_ATTACK_BONUS,
  ARCHER_DEFENSE_BONUS,
  CAVALRY_ATTACK_BONUS,
  CAVALRY_DEFENSE_BONUS,
  SPECIAL_TROOP_COMBAT_BONUS,
} = require('./rules/shared');
const { resolveExpansion } = require('./rules/expansion');
const { factionByNumber, factionsAreAdjacent } = require('./rules/territory');

const {
  ACTION_JOIN_FACTION,
  ACTION_ATTACK,
  ACTION_ALLIANCE,
  ACTION_DEFEND,
  ACTION_LEVAS,
  ACTION_ARQUEROS,
  ACTION_CABALLEROS,
  ACTION_CONQUISTA,
  ACTION_DUNGEON,
  ACTION_TOWER,
  ACTION_BOSS,
  ACTION_CASAS,
  VALID_PHASE_BY_ACTION,
} = commands;

const SUMMARY_MS_PER_BLOCK = 12000; // 10-15s por bloque, ver docs/GDD seccion 5
const TRANSITION_MS = 12000; // duracion del paron del esqueleto entre fases, 10-15s pedidos por el usuario

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
  // Matar el timer de la partida ANTERIOR antes de reemplazarla. Sin esto, el
  // timer pendiente de la partida vieja (p.ej. el de la fase de resumen) sigue
  // corriendo, salta cuando ya existe la partida nueva y revienta contra su
  // `assertPhase` — y como salta dentro de un setTimeout, la excepcion no la
  // recoge nadie y se lleva el proceso del servidor por delante. Se dispara
  // con el flujo normal de "🔄 Nueva partida" del panel de admin.
  // `clearTimer()` lee `match`, asi que tiene que ir antes de reasignarlo.
  clearTimer();

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
    // Iglesia (nivel 3 de industria, ver rules/industry.js): efecto
    // permanente en cuanto se pone a true, sin fase de "armado" — +50 al
    // limite de tropas de cada jugador de la faccion (ver
    // effectiveTroopLimit() en rules/shared.js) y el cliente pinta el
    // edificio junto a la capital.
    churchBuilt: false,
    // Viviendas construidas con !casas (ver rules/housing.js): 0 a
    // MAX_HOUSES_PER_FACTION (10), +5 al limite de tropas de cada jugador
    // de la faccion por cada una (ver effectiveTroopLimit() en
    // rules/shared.js) — acumulable con la iglesia, a diferencia de esta
    // no es un interruptor sino un contador.
    housesBuilt: 0,
    specialEnabled: !!f.specialEnabled,
    specialAbility: f.specialAbility || null,
    specialUsed: false,
    territoryIds: [],
    // Capital de la faccion (ver docs/ACCIONES.md): una de sus casillas
    // iniciales, elegida al crear la partida un poco mas abajo (aqui todavia
    // no hay territoryIds que elegir). `capitalVillagerCount` es cuantos
    // aldeanos pasean alrededor, sorteado una vez al crear la partida (4-8,
    // "aleatorio el numero entre esos que dije" tal y como se pidio) y fijo
    // el resto de la partida.
    capitalTileId: null,
    capitalVillagerCount: 0,
    // Trofeos de dungeon ganados (ver !dungeon, rules/structures.js
    // seccion 27): cada uno es una estatua nueva junto a la capital, con
    // sus propios aldeanos paseando alrededor — el cliente decide DONDE
    // colocar cada una (aqui solo se cuenta cuantas hay).
    dungeonTrophies: 0,
    // Castillo especial del nivel 4 de industria (ver rules/industry.js):
    // `specialCastleBuilt` se pone a true la ronda en que se desbloquea (el
    // cliente lo usa para saber si ya hay que pintar el castillo junto a la
    // capital). Las tropas especiales que produce (2 al construirse, +1/ronda
    // despues, tope 10 por facción) ya NO se guardan aquí — se reparten
    // directas a `player.specialTroops` (ver rules/industry.js
    // grantSpecialTroops()), son tropas normales del jugador de ahí en
    // adelante.
    specialCastleBuilt: false,
    // Museos (trofeo de `!boss`, ver rules/bosses.js sección 31): uno por
    // cada boss derrotado, sin tope — cada uno da +1 leva/ronda, +1
    // industria/ronda, +2 de defensa base, acumulables. Igual mecanismo
    // visual que las estatuas de dungeon (anillo alrededor de la capital).
    bossTrophies: 0,
    killsCaused: 0,
    // Miembros que tenia la faccion al cerrar el reclutamiento. Se rellena en
    // closeRecruitment(); antes de eso vale 0 y los umbrales de industria caen
    // en su suelo minimo (ver industryThresholdsFor en rules/industry.js).
    rosterSize: 0,
  }));

  const { tiles, mapLayout, structures, wonders, bosses } = generateMap({
    tileCount: normalizedConfig.map.tileCount,
    factionCount: factions.length,
    mode: normalizedConfig.map.mode,
    mapKey: normalizedConfig.map.key,
    // Dungeons solo se generan si el admin los activó en el panel (ver
    // futureFeatures.dungeons más abajo) — 1 a 5 al azar por partida.
    dungeonsEnabled: normalizedConfig.futureFeatures.dungeons,
    // Maravillas (ver futureFeatures.wonders más abajo, docs/ACCIONES.md
    // sección 30) — 2 a 6 al azar por partida, sin repetir ninguna.
    wondersEnabled: normalizedConfig.futureFeatures.wonders,
    // Bosses (ver futureFeatures.bosses más abajo, docs/ACCIONES.md
    // sección 31) — 1 a 3 al azar por partida, sin repetir ninguno.
    bossesEnabled: normalizedConfig.futureFeatures.bosses,
  });

  for (const tile of tiles) {
    if (tile.ownerFactionNumber != null) {
      findInFactionList(factions, tile.ownerFactionNumber).territoryIds.push(tile.id);
    }
  }

  // Capital: una casilla al azar de las iniciales de cada faccion (ver
  // docs/ACCIONES.md) — se sortea aqui, UNA sola vez, porque territoryIds ya
  // esta completo pero todavia nadie ha podido conquistar ni perder terreno.
  for (const faction of factions) {
    if (faction.territoryIds.length === 0) continue;
    faction.capitalTileId = faction.territoryIds[Math.floor(Math.random() * faction.territoryIds.length)];
    faction.capitalVillagerCount = 4 + Math.floor(Math.random() * 5); // 4 a 8 (ambos incluidos)
  }

  match = {
    phase: PHASE_CONFIG,
    config: normalizedConfig,
    factions,
    tiles,
    mapLayout, // estatico durante toda la partida, ver getMapLayout() y docs/ACCIONES.md
    // Estructuras conquistables (castillo/aldea/puerto, ver `!conquista` en
    // rules/structures.js): a diferencia de `mapLayout` esto SÍ es estado
    // mutable de partida (guarnición neutral, se vacía al conquistarse), por
    // eso vive aquí y no dentro de `mapLayout` — viaja en cada
    // `state:public`/`state:admin`, no solo una vez.
    structures,
    // Maravillas (ver rules/wonders.js, docs/ACCIONES.md sección 30):
    // estática igual que `structures`/`mapLayout` en cuanto a POSICIÓN (nunca
    // cambia de sitio ni de tipo en toda la partida) pero su DUEÑO no se
    // guarda aquí — se consulta en vivo a partir de `tile.ownerFactionNumber`
    // (ver wonderIndustryBonus()/wonderDefenseBonus()), así que basta con
    // `!ataque`/`!expansion` normales para "conquistarla", sin código propio.
    wonders,
    // Bosses (ver rules/bosses.js, docs/ACCIONES.md sección 31): SÍ es
    // estado mutable (`defeated` se pone a true al derrotarlo con `!boss`,
    // igual mecanismo que la guarnición de `structures`), por eso vive aquí.
    bosses,
    players: new Map(),
    round: 0,
    roundActions: new Map(),
    lastAttackerOf: {},
    activeAlliancePairsThisRound: new Set(),
    combatModifiers: {},
    summaryBlocks: [],
    winnerFactionNumber: null,
    timer: null,
    // Paron decorativo entre fases (esqueleto con cartel) — null cuando no
    // hay ninguno en curso. Ver enterTransition().
    transition: null,
  };

  notifyStateChange();
  return getAdminState();
}

/** Entero saneado dentro de [min,max], o `fallback` si no es un numero valido. */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeConfig(config) {
  return {
    factions: config.factions,
    channels: config.channels || [],
    map: {
      tileCount: config.map?.tileCount ?? 20,
      mode: config.map?.mode ?? 'neutral',
      // Que mapa jugar ('world' | 'iberia', ver AVAILABLE_MAPS/DEFAULT_MAP_KEY
      // en mapTemplates.js) — cambia el PNG de fondo y sobre que silueta de
      // tierra real se reparten territorios/decoraciones.
      key: config.map?.key || DEFAULT_MAP_KEY,
    },
    // Casillas del panel de admin (ver docs/ACCIONES.md): `dungeons`,
    // `wonders` y `bosses` YA tienen efecto real (createMatch() se lo pasa a
    // generateMap(), ver dungeonsEnabled/wondersEnabled/bossesEnabled más
    // arriba) — weather/randomEvents siguen sin implementar, solo se
    // guardan para cuando se hagan.
    futureFeatures: {
      wonders: !!config.futureFeatures?.wonders,
      dungeons: !!config.futureFeatures?.dungeons,
      bosses: !!config.futureFeatures?.bosses,
      weather: !!config.futureFeatures?.weather,
      randomEvents: !!config.futureFeatures?.randomEvents,
    },
    // Limite de tropas de IA (aiTroops+archerTroops+cavalryTroops) que puede
    // llevar CADA jugador — ver rules/troops.js/troopBuildings.js
    // (distributeTroops) y docs/ACCIONES.md. 1-200, por defecto 50.
    troopLimitPerPlayer: clampInt(config.troopLimitPerPlayer, 1, 200, 50),
    // Cuantos jugadores como mucho puede aceptar cada facción durante el
    // reclutamiento (!faccionN) — ver joinFaction(). 1-100, por defecto sin
    // límite práctico (100).
    maxPlayersPerFaction: clampInt(config.maxPlayersPerFaction, 1, 100, 100),
    alliancesEnabled: !!config.alliancesEnabled,
    thresholds: {
      // `!expansion` ya NO tiene umbral de porcentaje: lo que decide cuantas
      // casillas se ganan es el numero de votantes (ver rules/expansion.js,
      // tilesWonByVotes). Alianza y especial si siguen siendo por porcentaje.
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

  // Limite de jugadores por facción (config.maxPlayersPerFaction, panel de
  // admin): no cuenta contra el límite volver a escribir el mismo !facciónN
  // (no suma un miembro nuevo) — solo unirse a esta facción por primera vez
  // o cambiarse desde otra distinta.
  if (!existing || existing.factionNumber !== factionNumber) {
    let currentMembers = 0;
    for (const p of match.players.values()) if (p.factionNumber === factionNumber) currentMembers++;
    if (currentMembers >= match.config.maxPlayersPerFaction) return false;
  }

  match.players.set(userId, {
    userId,
    username,
    factionNumber,
    alive: true,
    unitType: existing ? existing.unitType : 'soldier',
    participation: existing ? existing.participation : 0,
    aiTroops: existing ? existing.aiTroops : 0,
    archerTroops: existing ? existing.archerTroops : 0,
    cavalryTroops: existing ? existing.cavalryTroops : 0,
    // Tropa especial del castillo del nivel 4 de industria (ver
    // rules/industry.js grantSpecialTroops()) — tropa normal del jugador de
    // ahí en adelante: sigue en su cono de acompañantes, cuenta para su
    // límite de tropas, muere en combate como cualquier otra (ver
    // SPECIAL_TROOP_COMBAT_BONUS en rules/shared.js).
    specialTroops: existing ? existing.specialTroops : 0,
    // Cuantas tropas (de los 4 tipos juntos) ganó o perdió este jugador la
    // ULTIMA ronda resuelta, sea por combate o por reclutamiento — ver
    // snapshot antes/después en resolveRound(). El cliente lo pinta en verde
    // (+x) o rojo (-x) encima del jugador, junto a su HUD de poder.
    troopDeltaLastRound: existing ? existing.troopDeltaLastRound : 0,
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

  // Sin frontera compartida (casilla con casilla) no se puede atacar: hace
  // falta conquistar terreno neutral con !expansion hasta tocar al enemigo.
  // Se rechaza igual que un comando invalido cualquiera (como si no se
  // hubiera escrito nada), no es un caso especial en el chat ni en el mapa.
  if (actionType === ACTION_ATTACK && !factionsAreAdjacent(match, player.factionNumber, targetFactionNumber)) {
    return false;
  }

  match.roundActions.set(userId, { type: actionType, targetFactionNumber });
  notifyStateChange();
  return true;
}

// ---------------------------------------------------------------------------
// Transiciones de fase
// ---------------------------------------------------------------------------

/**
 * Entra en el paron decorativo entre fases (PHASE_TRANSITION): mientras dura
 * ningun comando de chat es valido (VALID_PHASE_BY_ACTION no tiene esta fase
 * como requerida de ninguna accion, se rechazan solas) y la ronda de verdad
 * NO avanza todavia — `onDone` es quien hace el cambio de fase real, y solo
 * se ejecuta cuando expira el timer (o el admin fuerza el avance). `kind` y
 * `round` son solo para que el cliente sepa que cartel dibujarle al
 * esqueleto (ver public/index.html): 'first-action' | 'summary' | 'next-round'.
 */
function enterTransition(kind, round, onDone) {
  match.transition = { kind, round };
  match.phase = PHASE_TRANSITION;
  startTimer(TRANSITION_MS, () => {
    match.transition = null;
    onDone();
  });
  notifyStateChange();
}

function closeRecruitment() {
  assertPhase(PHASE_RECRUITMENT);

  // El roster queda fijo aqui (ya no se puede entrar ni cambiar de faccion),
  // asi que este es el momento de congelar cuanta gente tiene cada faccion.
  // Los umbrales de industria se calculan a partir de ESTE numero y no de los
  // vivos de cada momento — ver industryThresholdsFor() en rules/industry.js
  // para el porque (si bajara con cada baja, las marcas de la probeta se
  // moverian solas a mitad de partida).
  for (const faction of match.factions) {
    faction.rosterSize = [...match.players.values()].filter((p) => p.factionNumber === faction.number).length;
  }

  match.round = 1;
  match.roundActions.clear();
  enterTransition('first-action', match.round, () => {
    match.phase = PHASE_ACTION;
    startTimer(match.config.timers.actionMs, closeActionPhase);
    notifyStateChange();
  });
}

function closeActionPhase() {
  assertPhase(PHASE_ACTION);
  clearTimer();
  match.phase = PHASE_RESOLUTION;
  resolveRound();
}

/** Total de tropas de IA (los 4 tipos juntos) que lleva un jugador ahora mismo. */
function totalAiTroops(player) {
  return (player.aiTroops || 0) + (player.archerTroops || 0) + (player.cavalryTroops || 0) + (player.specialTroops || 0);
}

function resolveRound() {
  const context = tallyActions();
  // Foto de cuantas tropas lleva cada uno ANTES de resolver nada de la
  // ronda (combate, reclutamiento pasivo, !levas/!arqueros/!caballeros...)
  // para poder calcular troopDeltaLastRound al final por diferencia — ver
  // docs/ACCIONES.md, "HUD de poder por jugador".
  const troopsBefore = new Map();
  for (const [userId, player] of match.players) troopsBefore.set(userId, totalAiTroops(player));

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
  resolveConquista(match, context);
  resolveDungeon(match, context);
  resolveBoss(match, context);
  resolveTowers(match, context);
  resolveIndustry(match, context);
  resolveAiTroops(match);
  resolveTroopBuildings(match, context);
  resolveCasas(match, context);
  resolveExpansion(match, context);

  for (const [userId, player] of match.players) {
    player.troopDeltaLastRound = totalAiTroops(player) - (troopsBefore.get(userId) || 0);
  }

  match.summaryBlocks = buildRoundSummary(context);
  enterTransition('summary', match.round, () => {
    match.phase = PHASE_SUMMARY;
    startTimer(Math.max(match.summaryBlocks.length, 1) * SUMMARY_MS_PER_BLOCK, advanceRound);
    notifyStateChange();
  });
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
  enterTransition('next-round', match.round, () => {
    match.phase = PHASE_ACTION;
    startTimer(match.config.timers.actionMs, closeActionPhase);
    notifyStateChange();
  });
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
      [ACTION_LEVAS]: [],
      [ACTION_ARQUEROS]: [],
      [ACTION_CABALLEROS]: [],
      [ACTION_CONQUISTA]: [],
      [ACTION_DUNGEON]: [],
      [ACTION_TOWER]: [],
      [ACTION_BOSS]: [],
      [ACTION_CASAS]: [],
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
    roundEvents: { conquests: [], combats: [], industryUnlocks: [], eliminations: [], structureConquests: [], bossKills: [] },
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
  if (context.roundEvents.structureConquests.length > 0) blocks.push({ kind: 'structureConquests', data: context.roundEvents.structureConquests });
  if (context.roundEvents.bossKills.length > 0) blocks.push({ kind: 'bossKills', data: context.roundEvents.bossKills });

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
      structures: [],
      wonders: [],
      bosses: [],
      players: [],
      summaryBlocks: [],
      winnerFactionNumber: null,
      timerEndsAt: null,
      timerPaused: false,
      transition: null,
    };
  }
  const liveCounts = countLiveActions();
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
      // Ver docs/ACCIONES.md: casilla con el placeholder de capital de esta
      // faccion y cuantos aldeanos pasean alrededor. Sigue apuntando a la
      // MISMA casilla aunque la pierda en combate (es solo decorativo, sin
      // efecto de juego todavia) — no se recalcula sola.
      capitalTileId: f.capitalTileId,
      capitalVillagerCount: f.capitalVillagerCount,
      dungeonTrophies: f.dungeonTrophies,
      // Iglesia del nivel 3 de industria (ver rules/industry.js): el
      // cliente pinta el edificio junto a la capital en cuanto es true, con
      // el mismo anillo anti-solape que estatua/museo. El +50 al limite de
      // tropas ya esta aplicado del lado del servidor (ver
      // effectiveTroopLimit() en rules/shared.js), esto es solo la señal
      // visual.
      churchBuilt: f.churchBuilt,
      // Viviendas construidas con !casas (ver rules/housing.js): 0-10, el
      // cliente pinta una por cada una en el anillo de la capital, y el +5
      // al limite de tropas por cada una ya esta aplicado del lado del
      // servidor (effectiveTroopLimit() en rules/shared.js).
      housesBuilt: f.housesBuilt || 0,
      // Castillo especial del nivel 4 de industria (ver rules/industry.js):
      // el cliente pinta el edificio junto a la capital en cuanto
      // `specialCastleBuilt` es true — SIN tropas propias alrededor (ya no
      // son decorativas: siguen a su jugador, ver player.specialTroops más
      // abajo).
      specialCastleBuilt: f.specialCastleBuilt,
      // Defensa pasiva TOTAL que dan las torres terminadas de esta faccion
      // (0.5 cada una, ver rules/towers.js) — se suma SIEMPRE al calculo de
      // combate, aunque nadie vote !defender esta ronda (ver resolveCombat en
      // rules/combat.js). El cliente la pinta junto a la capital como el
      // resto de stats de defensa.
      towerDefenseBonus: towerDefenseBonus(match, f),
      // Maravillas de tipo 'defense' (ver rules/wonders.js sección 30): igual
      // criterio que towerDefenseBonus arriba — se suma en vivo a partir de
      // qué maravillas posee la facción AHORA MISMO.
      wonderDefenseBonus: wonderDefenseBonus(match, f),
      // Museos (trofeo de `!boss`, ver rules/bosses.js sección 31): cuantos
      // tiene esta facción (`bossTrophies`, uno por boss derrotado) y su
      // bono de defensa pasiva TOTAL (+2 cada uno, se suma igual que
      // towerDefenseBonus arriba). El cliente los pinta junto a la capital
      // con el mismo mecanismo de anillo que las estatuas de dungeon.
      bossTrophies: f.bossTrophies,
      museumDefenseBonus: museumDefenseBonus(f),
      killsCaused: f.killsCaused,
      // Cuantas maravillas posee esta facción AHORA MISMO (ver
      // rules/wonders.js sección 30) — se cuenta en vivo a partir de quién
      // controla la casilla de cada una, igual que su bono de industria/
      // defensa; usado en la clasificación (leaderboard).
      wondersCount: match.wonders.filter((w) => match.tiles[w.tileId].ownerFactionNumber === f.number).length,
      // Recuento EN VIVO de la fase de accion en curso (ver countLiveActions):
      // cuanta gente de esta faccion esta defendiendo, y cuantos atacantes
      // tiene encima ahora mismo. El mapa los pinta como escudo verde / espada
      // roja sobre el territorio de la faccion — ver public/mapRenderer.js.
      defendersThisRound: liveCounts.defendersByFaction.get(f.number) || 0,
      incomingAttackersThisRound: liveCounts.incomingAttackersByFaction.get(f.number) || 0,
      // Los 4 umbrales de mejora DE ESTA FACCION (dependen de su tamaño, ver
      // industryThresholdsFor en rules/industry.js) — son las 4 marcas de su
      // probeta. Se mandan calculados desde aqui para que la regla viva en un
      // unico sitio y el cliente solo tenga que pintarlos.
      industryThresholds: industryThresholdsFor(f),
    })),
    tiles: match.tiles.map((t) => ({
      id: t.id,
      ownerFactionNumber: t.ownerFactionNumber,
      neutral: t.neutral,
      industryCount: t.industryCount,
      leviesCount: t.leviesCount,
      archeryCount: t.archeryCount,
      cavalryCount: t.cavalryCount,
      towerCount: t.towerCount,
      towerBuildingCount: t.towerBuildingCount,
    })),
    // TODAS las estructuras, conquistadas o no (antes se omitían las ya
    // conquistadas porque su guarnición está a 0 y no había nada más que
    // enseñar — pero el cliente necesita seguir sabiendo DÓNDE estaba cada
    // una para dibujar sus aldeanos alrededor una vez conquistada, ver
    // `conquered` y paintStructureMarkers()/paintVillagerWalkers() en
    // public/mapRenderer.js). Su producción sigue viéndose igual que
    // cualquier edificio, en `tiles` de arriba.
    structures: match.structures.map((s) => {
      const conquered = s.aiTroops + s.archerTroops + s.cavalryTroops + s.orcCount + s.goblinCount === 0;
      return {
        tileId: s.tileId,
        // Posicion exacta del edificio dentro de su casilla (celdas de
        // rejilla, igual que `centroids` en mapLayout) — varias
        // estructuras pueden compartir tileId, así que el cliente ancla el
        // marcador y sus tropas paseando aquí, no en el centroide medio de
        // toda la casilla.
        x: s.x,
        y: s.y,
        type: s.type,
        conquered,
        aiTroops: s.aiTroops,
        archerTroops: s.archerTroops,
        cavalryTroops: s.cavalryTroops,
        // Solo los dungeon llevan guarnición de orcos/goblins (ver
        // rules/structures.js sección 27) — castillo/aldea/puerto siempre
        // van a 0 aquí.
        orcCount: s.orcCount,
        goblinCount: s.goblinCount,
        attackPower: Number(structureAttackPower(s).toFixed(2)),
        defensePower: Number(structureDefensePower(s).toFixed(2)),
      };
    }),
    // Maravillas (ver rules/wonders.js, docs/ACCIONES.md sección 30):
    // posición y bono fijos toda la partida, `ownerFactionNumber` se calcula
    // aquí en vivo a partir de quién controla `tileId` ahora mismo — no hace
    // falta ningún comando para "conquistarlas", basta con poseer la
    // casilla (`!ataque`/`!expansion` normales).
    wonders: match.wonders.map((w) => ({
      tileId: w.tileId,
      x: w.x,
      y: w.y,
      key: w.key,
      name: w.name,
      icon: w.icon,
      bonusType: w.bonusType,
      bonusAmount: w.bonusAmount,
      ownerFactionNumber: match.tiles[w.tileId].ownerFactionNumber,
    })),
    // Bosses (ver rules/bosses.js, docs/ACCIONES.md sección 31): posición y
    // tipo fijos toda la partida, `defeated` es lo único mutable — el
    // cliente deja de pintarlo (y de contarlo como "vagando por el mapa")
    // en cuanto lo ve a true.
    bosses: match.bosses.map((b) => ({
      tileId: b.tileId,
      x: b.x,
      y: b.y,
      key: b.key,
      attackPower: b.attackPower,
      defensePower: b.defensePower,
      defeated: b.defeated,
      defeatedByFactionNumber: b.defeatedByFactionNumber,
    })),
    players: [...match.players.values()].map((p) => {
      // Que esta haciendo este jugador AHORA MISMO, para que el mapa pueda
      // animar su marcador segun el comando que haya escrito (irse a la
      // frontera si ataca, a un castillo si defiende, etc. — ver la capa de
      // caminantes en public/mapRenderer.js). Solo tiene sentido durante la
      // fase de accion: fuera de ella los votos son los de la ronda pasada
      // (todavia sin limpiar) y el marcador debe volver a pasear, asi que se
      // manda `null` y el cliente lo interpreta como "sin orden".
      const action = match.phase === PHASE_ACTION ? match.roundActions.get(p.userId) : null;
      return {
        userId: p.userId,
        username: p.username,
        factionNumber: p.factionNumber,
        alive: p.alive,
        unitType: p.unitType,
        // Tropas de IA que lleva este jugador — el cliente pinta un
        // acompañante por cada una, siguiendo su rastro en el mapa (ver
        // public/mapRenderer.js). aiTroops = soldados (generación pasiva por
        // territorio, ver rules/troops.js, y !levas), archerTroops/
        // cavalryTroops = solo via !arqueros/!caballeros (ver
        // rules/troopBuildings.js).
        aiTroops: p.aiTroops || 0,
        archerTroops: p.archerTroops || 0,
        cavalryTroops: p.cavalryTroops || 0,
        // Tropa especial del castillo del nivel 4 de industria (ver
        // rules/industry.js) — sigue al jugador como cualquier otra, con su
        // propio sprite ('tropa-especial').
        specialTroops: p.specialTroops || 0,
        troopDeltaLastRound: p.troopDeltaLastRound || 0,
        // Poder de ataque/defensa que aportan SUS tropas ahora mismo — la
        // misma cuenta que hace sumRandomPower() en rules/shared.js para el
        // bonus FIJO por tropa (sin la tirada al azar del soldado/caballero
        // en sí, que solo existe en el instante de un combate real). El
        // cliente lo pinta encima de su cabeza (HUD de poder), ver
        // public/mapRenderer.js.
        attackPower: AI_TROOP_COMBAT_BONUS * (p.aiTroops || 0) + ARCHER_ATTACK_BONUS * (p.archerTroops || 0) + CAVALRY_ATTACK_BONUS * (p.cavalryTroops || 0) + SPECIAL_TROOP_COMBAT_BONUS * (p.specialTroops || 0),
        defensePower: AI_TROOP_COMBAT_BONUS * (p.aiTroops || 0) + ARCHER_DEFENSE_BONUS * (p.archerTroops || 0) + CAVALRY_DEFENSE_BONUS * (p.cavalryTroops || 0) + SPECIAL_TROOP_COMBAT_BONUS * (p.specialTroops || 0),
        action: action ? action.type : null,
        actionTargetFactionNumber: action ? action.targetFactionNumber ?? null : null,
      };
    }),
    summaryBlocks: match.phase === PHASE_SUMMARY ? match.summaryBlocks : [],
    winnerFactionNumber: match.winnerFactionNumber,
    // Paron decorativo del esqueleto entre fases (ver enterTransition) —
    // { kind, round } mientras dura, null el resto del tiempo.
    transition: match.transition,
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

/**
 * Recuento EN VIVO de los votos de ataque/defensa de la fase de accion que
 * este ahora mismo abierta, para que el mapa pueda enseñar el escudo de
 * defensores y la espada de atacantes MIENTRAS la gente escribe en el chat
 * (no al resolver la ronda). Solo cuenta jugadores vivos, y solo durante
 * `PHASE_ACTION`: fuera de esa fase los votos ya no significan nada (o son
 * los de la ronda pasada, sin limpiar todavia), asi que se devuelve vacio y
 * los iconos desaparecen del mapa.
 *
 * No reutiliza `tallyActions()` a proposito: aquella construye el contexto
 * completo de resolucion (buckets por tipo, inactivos, eventos de ronda) y
 * ademas suma `participation` a cada jugador — llamarla desde aqui, que se
 * ejecuta en CADA envio de estado, corromperia esas cuentas.
 */
function countLiveActions() {
  const defendersByFaction = new Map();
  const incomingAttackersByFaction = new Map();
  if (!match || match.phase !== PHASE_ACTION) return { defendersByFaction, incomingAttackersByFaction };

  for (const [userId, action] of match.roundActions) {
    const player = match.players.get(userId);
    if (!player || !player.alive) continue;

    if (action.type === ACTION_DEFEND) {
      defendersByFaction.set(player.factionNumber, (defendersByFaction.get(player.factionNumber) || 0) + 1);
    } else if (action.type === ACTION_ATTACK && action.targetFactionNumber != null) {
      const target = action.targetFactionNumber;
      incomingAttackersByFaction.set(target, (incomingAttackersByFaction.get(target) || 0) + 1);
    }
  }
  return { defendersByFaction, incomingAttackersByFaction };
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
