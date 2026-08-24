'use strict';

const { ACTION_CASAS } = require('../commands');
const { MAX_HOUSES_PER_FACTION } = require('./shared');

/**
 * `!casas`: construye UNA vivienda junto a la capital por cada voto, hasta
 * MAX_HOUSES_PER_FACTION (10) por facción — mismo patrón "un voto, un
 * edificio" que !levas/!arqueros/!caballeros (ver
 * rules/troopBuildings.js buildFromVotes()), pero la vivienda no le
 * pertenece a un jugador ni vive en una casilla: es una decoración anclada
 * a la capital (ver desiredSiteSpecs() en public/mapRenderer.js), así que
 * solo hace falta contar cuántas lleva la facción (`faction.housesBuilt`).
 *
 * No da tropas: sube el LÍMITE de tropas de CADA jugador de la facción +5
 * por vivienda (ver HOUSE_TROOP_LIMIT_BONUS/effectiveTroopLimit en
 * rules/shared.js), igual que la iglesia pero acumulable hasta 10 veces en
 * vez de una sola. Votos de más una vez alcanzado el tope se pierden sin
 * error, igual que cualquier otro voto sin efecto.
 */
function resolveCasas(match, context) {
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    const votes = context.votesByFactionAndType.get(faction.number)[ACTION_CASAS];
    if (!votes || votes.length === 0) continue;

    for (let i = 0; i < votes.length; i++) {
      if ((faction.housesBuilt || 0) >= MAX_HOUSES_PER_FACTION) break;
      faction.housesBuilt = (faction.housesBuilt || 0) + 1;
    }
  }
}

module.exports = { resolveCasas };
