'use strict';

const commands = require('../commands');

/**
 * Clima (ver docs/ACCIONES.md sección 36): 4 tipos, uno como mucho activo a
 * la vez, dura exactamente 1 ronda (se sortea de nuevo — o ninguno — al
 * entrar en cada Fase de Acción nueva, ver enterActionPhase() en
 * gameEngine.js) y solo si el admin activó `futureFeatures.weather` al
 * crear la partida (mismo interruptor que ya existía como no-op, ahora con
 * efecto real).
 *
 * Tirada, decisión propia documentada por ambigüedad de la especificación
 * original: cada tipo se comprueba de forma INDEPENDIENTE con su propio %
 * ("soleado" 20%, el resto 10% cada uno) — si ninguno sale, no hay clima esa
 * ronda; si sale más de uno a la vez (raro, pero posible con tiradas
 * independientes), se elige uno al azar entre los que salieron, que es lo
 * que pidió el usuario textualmente para el caso general ("si se activa
 * clima es aleatorio entre los que tenemos actualmente").
 */
const WEATHER_TYPES = {
  niebla: { chancePercent: 10 },
  lluvia: { chancePercent: 10 },
  nieve: { chancePercent: 10 },
  soleado: { chancePercent: 20 },
};

// Lluvia: -2 de defensa PLANA en cada combate PvP esa ronda (rules/combat.js) —
// solo PvP, tal y como se pidió explícitamente ("capitales en combate pvp,
// no en pve").
const RAIN_DEFENSE_PENALTY = 2;

// Soleado: +1 de ataque Y +1 de defensa para cada jugador en combate PvE esa
// ronda (boss/!conquista/!dungeon, ver rules/bosses.js y rules/structures.js).
const SUNNY_PVE_BONUS = 1;

// Niebla: bloquea !ataque. Nieve: bloquea todo comando de ataque/expansión
// PvE y PvP (ver docs/ACCIONES.md sección 36 para la lista exacta pedida).
const FOG_BLOCKED_ACTIONS = new Set([commands.ACTION_ATTACK]);
const SNOW_BLOCKED_ACTIONS = new Set([
  commands.ACTION_ATTACK,
  commands.ACTION_CONQUISTA,
  commands.ACTION_DUNGEON,
  commands.ACTION_BOSS,
  commands.ACTION_EXPAND,
]);

/** Sortea el clima de la ronda que empieza, o `null` si no toca ninguno (o el admin no activó el clima). */
function rollWeather(match) {
  if (!match.config.futureFeatures.weather) return null;
  const candidates = Object.keys(WEATHER_TYPES).filter(
    (key) => Math.random() * 100 < WEATHER_TYPES[key].chancePercent
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Si el clima activo esta ronda impide votar esta acción (ver castAction() en gameEngine.js). */
function weatherBlocksAction(match, actionType) {
  const weather = match.activeWeather;
  if (weather === 'niebla') return FOG_BLOCKED_ACTIONS.has(actionType);
  if (weather === 'nieve') return SNOW_BLOCKED_ACTIONS.has(actionType);
  return false;
}

/** Penalización de defensa PvP de esta ronda por lluvia (0 si no llueve). */
function rainDefensePenalty(match) {
  return match.activeWeather === 'lluvia' ? RAIN_DEFENSE_PENALTY : 0;
}

/** Bono de ataque/defensa PvE de esta ronda por sol (0 si no hace sol). */
function sunnyPveBonus(match) {
  return match.activeWeather === 'soleado' ? SUNNY_PVE_BONUS : 0;
}

module.exports = {
  WEATHER_TYPES,
  RAIN_DEFENSE_PENALTY,
  SUNNY_PVE_BONUS,
  rollWeather,
  weatherBlocksAction,
  rainDefensePenalty,
  sunnyPveBonus,
};
