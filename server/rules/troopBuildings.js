'use strict';

const { ACTION_LEVAS, ACTION_ARQUEROS, ACTION_CABALLEROS } = require('../commands');
const { distributeTroops } = require('./troops');
const { effectiveTroopLimit } = require('./shared');

// Cuantas tropas da un edificio nuevo AL VOTANTE que lo construye, la ronda
// en que se construye — ver resolveTroopBuildings() para el porque no
// también produce su +1 esa misma ronda (se pidió que el +1 empezara la
// ronda SIGUIENTE).
const BUILDING_INITIAL_BONUS = 5;

// Cuántas rondas produce tropa cada edificio DESPUÉS de construirse (la
// ronda en que se construye no cuenta, ver comentario de resolveTroopBuildings
// más abajo) — pasadas esas rondas deja de dar nada, hay que levantar otro
// para que esa casilla vuelva a producir. El edificio se queda en pie (sigue
// contando para leviesCount/archeryCount/cavalryCount, se sigue dibujando),
// solo deja de sumar tropa nueva.
const PRODUCTION_ROUNDS = 3;

/**
 * Los 3 edificios de tropa que se pueden votar en la Fase de Acción, misma
 * mecánica que !industria (un voto, un edificio, sin objetivo — ver
 * rules/industry.js buildIndustries()) con una diferencia: el edificio de
 * industria no le pertenece a nadie en particular, pero el bono inicial de
 * estos SÍ es directo para quien lo votó (ver buildFromVotes()).
 *
 *   !levas      -> barraca         -> tropas 'aiTroops'     (soldados, +0.1 atk/+0.1 def)
 *   !arqueros   -> campo-arqueria  -> tropas 'archerTroops'  (+0.2 atk / 0 def)
 *   !caballeros -> caballeriza     -> tropas 'cavalryTroops' (0 atk / +0.2 def)
 *
 * Los bonos de combate de cada tipo viven en rules/shared.js
 * (ARCHER_ATTACK_BONUS etc.) — aquí solo se generan y reparten tropas.
 */
const BUILDING_TYPES = [
  { actionType: ACTION_LEVAS, tileField: 'leviesCount', roundsField: 'leviesRounds', troopField: 'aiTroops' },
  { actionType: ACTION_ARQUEROS, tileField: 'archeryCount', roundsField: 'archeryRounds', troopField: 'archerTroops' },
  { actionType: ACTION_CABALLEROS, tileField: 'cavalryCount', roundsField: 'cavalryRounds', troopField: 'cavalryTroops' },
];

/**
 * Se llama desde gameEngine.resolveRound() cada ronda, después de
 * resolveAiTroops(). En dos pasadas, en este orden:
 *
 * 1. Producción de los edificios YA en pie que TODAVÍA están dentro de sus
 *    PRODUCTION_ROUNDS rondas de vida (construidos hace 1-3 rondas, ver
 *    countFactionActiveBuildings — uno más viejo sigue en pie pero ya no
 *    cuenta aquí): 1 tropa de su tipo por edificio activo, en las casillas
 *    que la facción controla AHORA MISMO (si conquistó una casilla con
 *    edificio ajeno, ya es suya — igual que industryCount, ver
 *    mapTemplates.js). Repartida con distributeTroops() (prioriza a quien
 *    tenga menos de ese tipo), NO al jugador que lo construyó — el dueño
 *    original puede haber muerto o el territorio haber cambiado de manos.
 * 2. Construcción de los edificios votados ESTA ronda: uno por voto, en una
 *    casilla al azar de las que controla la facción, con el bono de
 *    BUILDING_INITIAL_BONUS directo para quien votó.
 *
 * El orden importa: un edificio construido esta ronda no cuenta todavía en
 * el paso 1 de esta misma ronda (ya que el paso 1 se ejecuta antes de que
 * se construya), así que da el +5 inicial pero no un +1 extra encima —
 * empieza a producir la ronda siguiente, tal y como se pidió.
 */
function resolveTroopBuildings(match, context) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    for (const { roundsField, troopField } of BUILDING_TYPES) {
      const active = countFactionActiveBuildings(match, faction, roundsField);
      distributeTroops(match, faction, active, troopField);
    }
  }

  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    const votes = context.votesByFactionAndType.get(faction.number);
    for (const { actionType, tileField, roundsField, troopField } of BUILDING_TYPES) {
      buildFromVotes(match, faction, votes[actionType], tileField, roundsField, troopField);
    }
  }
}

/**
 * Edificios de un tipo que TODAVÍA producen (construidos hace 1 a
 * PRODUCTION_ROUNDS rondas, ambos inclusive, o `null` = permanente, ver
 * conquerStructure() en rules/structures.js) sobre las casillas que la
 * facción controla ahora mismo — uno más viejo sigue en pie (sigue en
 * `tile[tileField]`, se sigue dibujando) pero ya no cuenta aquí.
 */
function countFactionActiveBuildings(match, faction, roundsField) {
  let total = 0;
  for (const tileId of faction.territoryIds) {
    const rounds = match.tiles[tileId][roundsField] || [];
    for (const roundBuilt of rounds) {
      if (roundBuilt === null) { total++; continue; }
      const age = match.round - roundBuilt;
      if (age >= 1 && age <= PRODUCTION_ROUNDS) total++;
    }
  }
  return total;
}

/**
 * Un edificio por cada userId en `userIds` (uno por voto, como
 * buildIndustries), cada uno en una casilla al azar de las que la facción
 * controla ahora mismo, y el bono inicial directo para ESE votante (a
 * diferencia de la producción pasiva, que reparte por prioridad — aquí no
 * hace falta: quien vota es quien construye, así que es justo que se lo
 * lleve él).
 */
function buildFromVotes(match, faction, userIds, tileField, roundsField, troopField) {
  if (!userIds || userIds.length === 0) return;
  const limit = effectiveTroopLimit(match, faction);
  for (const userId of userIds) {
    // El edificio se levanta pase lo que pase (efecto de la CASILLA, no del
    // votante) — solo el bono personal respeta el límite de tropas del
    // panel de admin, recortado al hueco que le quede al votante.
    const tileId = faction.territoryIds[Math.floor(Math.random() * faction.territoryIds.length)];
    match.tiles[tileId][tileField] += 1;
    match.tiles[tileId][roundsField].push(match.round);

    const player = match.players.get(userId);
    if (!player) continue;
    const current = (player.aiTroops || 0) + (player.archerTroops || 0) + (player.cavalryTroops || 0);
    const room = Math.max(0, limit - current);
    player[troopField] = (player[troopField] || 0) + Math.min(BUILDING_INITIAL_BONUS, room);
  }
}

module.exports = { resolveTroopBuildings, BUILDING_TYPES, BUILDING_INITIAL_BONUS, PRODUCTION_ROUNDS };
