'use strict';

const { ACTION_INDUSTRY } = require('../commands');
const { applyCasualties, shuffle } = require('./shared');
const { factionsAreAdjacent, factionByNumber, checkFactionElimination } = require('./territory');

// Cada casilla controlada rinde esto por ronda por el mero hecho de tenerla.
const PASSIVE_INDUSTRY_PER_TERRITORY = 0.1;
// Cada EDIFICIO de industria (uno por cada `!industria` votado, ver
// buildIndustries()) suma esto por ronda, ademas del rendimiento pasivo de su
// casilla. Como el edificio vive en la casilla (tile.industryCount, ver
// mapTemplates.js), conquistar una casilla con 1 industria le pasa al nuevo
// dueño los 0.1 + 0.5 = 0.6 completos.
const INDUSTRY_PER_BUILDING = 0.5;
const BOMBARDEO_DAMAGE = 3;
const OPESPECIAL_DAMAGE = 3;

/**
 * Las 4 mejoras, en orden fijo. `perPlayer` = industria acumulada necesaria
 * POR CADA JUGADOR de la faccion, no un numero absoluto.
 *
 * Por que por jugador y no fijo: la industria de una faccion crece con su
 * numero de miembros (cada `!industria` levanta un edificio que renta para
 * siempre), asi que con un umbral fijo la partida cambia por completo segun
 * cuanta gente haya en el chat. Medido con el modelo real: con umbrales fijos
 * de 10/20/30/40, una faccion de 3 personas desbloquea las 4 mejoras en las
 * rondas 4-6-7-9, pero una de 60 las tiene TODAS en la ronda 2. No existe un
 * numero fijo que funcione en los dos casos.
 *
 * Escalando el umbral con el tamaño de la faccion, la progresion sale igual
 * tenga 3 o 60 miembros (rondas ~4-7-10-13 con un 60% de participacion), y lo
 * que de verdad decide el ritmo pasa a ser cuanta gente colabora: con un 20%
 * de la faccion haciendo industria son las rondas 8-13-19-24; con el 100%,
 * 3-6-8-10.
 *
 * Son tambien las 4 marcas de la probeta del panel de facciones (ver
 * public/factionCards.js): el ultimo umbral es el que la llena del todo, asi
 * que cambiar estos numeros mueve las marcas solo. Y como el umbral depende
 * del tamaño de cada faccion, la probeta es comparable entre facciones
 * distintas: mide "como de bien coopera mi gente", no "cuanta gente tengo".
 */
const INDUSTRY_TIERS = [
  { key: 'tanque', perPlayer: 3 },
  { key: 'bombardeo', perPlayer: 8 },
  { key: 'tanque_x2', perPlayer: 15 },
  { key: 'operacion_especial', perPlayer: 24 },
];

// Suelo de jugadores al calcular los umbrales. Sin el, una faccion a la que
// no se une nadie (o que se queda sin miembros) tendria umbral 0 y
// desbloquearia las 4 mejoras de golpe en la primera ronda.
const MIN_PLAYERS_FOR_THRESHOLDS = 3;

/**
 * Los 4 umbrales absolutos de una faccion, ya multiplicados por su tamaño.
 * Se usa el roster fijado al cerrar el reclutamiento (`rosterSize`), no los
 * vivos de ahora mismo: si bajara con cada baja, las marcas de la probeta se
 * moverian solas a mitad de partida y una faccion diezmada desbloquearia
 * mejoras "gratis" justo por ir perdiendo.
 */
function industryThresholdsFor(faction) {
  const players = Math.max(MIN_PLAYERS_FOR_THRESHOLDS, faction.rosterSize || 0);
  return INDUSTRY_TIERS.map((tier) => tier.perPlayer * players);
}

/**
 * Levanta los edificios de industria votados esta ronda, suma la produccion
 * de cada faccion y desbloquea, en orden, las mejoras cuyo umbral se alcance.
 * Cada mejora se aplica una unica vez (ver docs/GDD seccion 6 "Industria y
 * las 4 mejoras").
 *
 * Produccion de una faccion = (casillas x PASSIVE_INDUSTRY_PER_TERRITORY) +
 * (edificios de industria en sus casillas x INDUSTRY_PER_BUILDING). Los
 * edificios construidos esta misma ronda ya cuentan para esta ronda.
 */
function resolveIndustry(match, context) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;

    const votes = context.votesByFactionAndType.get(faction.number)[ACTION_INDUSTRY].length;
    buildIndustries(match, context, faction, votes);

    const passive = faction.territoryIds.length * PASSIVE_INDUSTRY_PER_TERRITORY;
    const fromBuildings = countFactionIndustries(match, faction) * INDUSTRY_PER_BUILDING;
    const gained = faction.industryPenaltyActive ? 0 : passive + fromBuildings;
    faction.industryPenaltyActive = false;

    faction.industry += gained;
    faction.industryGainedLastRound = gained;

    const thresholds = industryThresholdsFor(faction);
    while (
      faction.industryTierIndex < INDUSTRY_TIERS.length &&
      faction.industry >= thresholds[faction.industryTierIndex]
    ) {
      applyIndustryTier(match, context, faction, INDUSTRY_TIERS[faction.industryTierIndex].key);
      faction.industryTierIndex++;
    }
  }
}

/**
 * Levanta un edificio de industria por cada `!industria` votado, cada uno en
 * una casilla AL AZAR de las que la faccion controla ahora mismo (varios
 * votos pueden caer en la misma casilla, igual que se pueden amontonar varias
 * fabricas en una misma region). Se llama con el reparto de territorio ya
 * resuelto de esta ronda, asi que nunca construye en una casilla que la
 * faccion acaba de perder.
 */
function buildIndustries(match, context, faction, count) {
  if (count <= 0) return;
  for (let i = 0; i < count; i++) {
    const tileId = faction.territoryIds[Math.floor(Math.random() * faction.territoryIds.length)];
    match.tiles[tileId].industryCount += 1;
  }
}

/** Edificios de industria en pie sobre las casillas que la faccion controla ahora mismo. */
function countFactionIndustries(match, faction) {
  let total = 0;
  for (const tileId of faction.territoryIds) total += match.tiles[tileId].industryCount;
  return total;
}

function applyIndustryTier(match, context, faction, tierKey) {
  context.roundEvents.industryUnlocks.push({ factionNumber: faction.number, tierKey });
  switch (tierKey) {
    case 'tanque':
      return upgradeRandomSoldiers(match, faction, 1, { prioritizeParticipation: false });
    case 'bombardeo':
      return applyBombardeo(match, context, faction);
    case 'tanque_x2':
      return upgradeRandomSoldiers(match, faction, 2, { prioritizeParticipation: true });
    case 'operacion_especial':
      return applyOperacionEspecial(match, context, faction);
    default:
      return;
  }
}

function upgradeRandomSoldiers(match, faction, count, { prioritizeParticipation }) {
  const soldiers = [...match.players.values()].filter(
    (p) => p.alive && p.factionNumber === faction.number && p.unitType === 'soldier'
  );
  const ordered = prioritizeParticipation
    ? soldiers.filter((p) => p.participation > 0).sort((a, b) => b.participation - a.participation)
    : shuffle(soldiers);

  const chosen = ordered.length >= count ? ordered.slice(0, count) : shuffle(soldiers).slice(0, count);
  chosen.forEach((player) => {
    player.unitType = 'tank';
  });
}

function applyBombardeo(match, context, faction) {
  // Simplificacion v1: usa la prioridad de bajas normal de esta ronda (inactivos primero)
  // en vez de la actividad de la ronda anterior. Pendiente de afinar si hace falta mas precision.
  const targetNumber = match.lastAttackerOf[faction.number];
  if (!targetNumber) return;
  const targetFaction = factionByNumber(match, targetNumber);
  if (!targetFaction || targetFaction.territoryIds.length === 0) return;
  applyCasualties(match, context, targetNumber, BOMBARDEO_DAMAGE, faction.number);
  checkFactionElimination(match, context, targetNumber, faction.number);
}

function applyOperacionEspecial(match, context, faction) {
  const adjacentEnemies = match.factions.filter(
    (f) => f.number !== faction.number && f.territoryIds.length > 0 && factionsAreAdjacent(match, faction.number, f.number)
  );
  const target = shuffle(adjacentEnemies)[0];
  if (!target) return;
  applyCasualties(match, context, target.number, OPESPECIAL_DAMAGE, faction.number);
  checkFactionElimination(match, context, target.number, faction.number);
}

module.exports = {
  resolveIndustry,
  INDUSTRY_TIERS,
  industryThresholdsFor,
  MIN_PLAYERS_FOR_THRESHOLDS,
  PASSIVE_INDUSTRY_PER_TERRITORY,
  INDUSTRY_PER_BUILDING,
};
