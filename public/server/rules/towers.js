'use strict';

const { ACTION_TOWER } = require('../commands');

// Defensa pasiva que da CADA torre terminada, siempre (no hace falta que
// nadie escriba !defender) — a diferencia del resto del combate, donde una
// facción sin nadie defendiendo entra con 0 (ver docs/GDD "El territorio no
// se defiende solo"). Las torres son justo la excepción: un suelo mínimo de
// defensa que no depende de que haya gente jugando esa ronda.
const TOWER_DEFENSE_BONUS = 0.5;
// Máximo de torres por facción, contando las YA terminadas + las en obras
// (para que no se pueda "hacer cola" de más de 10 votando varias rondas
// seguidas cuando ya faltan pocas para el límite).
const TOWER_MAX_PER_FACTION = 10;

/**
 * `!torre` (ver docs/ACCIONES.md sección 28): construcción en DOS rondas.
 * 1. Se vota `!torre` esta ronda -> aparece un placeholder "en obras" en una
 *    casilla al azar de la facción (`tile.towerBuildingCount`, mismo
 *    mecanismo que `tile.industryCount`/`leviesCount` — vive en la CASILLA,
 *    así que conquistarla a mitad de construcción se lleva la torre a medio
 *    hacer con ella).
 * 2. A la ronda SIGUIENTE, sin que nadie vuelva a votar, ese placeholder pasa
 *    solo a "torre terminada" (`tile.towerCount`) — la promoción pasa AQUÍ,
 *    antes de procesar los votos nuevos de esta misma ronda, así que un voto
 *    nuevo este turno no se promociona en el mismo turno en el que se pidió.
 */
function resolveTowers(match, context) {
  // 1) Promociona las torres en obras de la ronda anterior.
  for (const tile of match.tiles) {
    if (tile.towerBuildingCount > 0) {
      tile.towerCount += tile.towerBuildingCount;
      tile.towerBuildingCount = 0;
    }
  }

  // 2) Procesa los votos nuevos de esta ronda, respetando el límite de 10
  // por facción (ya terminadas + en obras, ver arriba).
  for (const faction of match.factions) {
    if (faction.territoryIds.length === 0) continue;
    const voters = context.votesByFactionAndType.get(faction.number)[ACTION_TOWER];
    if (!voters || voters.length === 0) continue;

    let current = towerTotalForFaction(match, faction);
    for (const _voter of voters) {
      if (current >= TOWER_MAX_PER_FACTION) break; // limite alcanzado: el resto de votos se pierden
      const tileId = faction.territoryIds[Math.floor(Math.random() * faction.territoryIds.length)];
      match.tiles[tileId].towerBuildingCount += 1;
      current++;
    }
  }
}

/** Torres terminadas + en obras que tiene AHORA MISMO una facción (para el límite de 10). */
function towerTotalForFaction(match, faction) {
  let total = 0;
  for (const tileId of faction.territoryIds) {
    total += match.tiles[tileId].towerCount + match.tiles[tileId].towerBuildingCount;
  }
  return total;
}

/** Torres terminadas (no las en obras, esas todavía no dan nada) que tiene una facción — para el bonus de defensa. */
function finishedTowerCountForFaction(match, faction) {
  let total = 0;
  for (const tileId of faction.territoryIds) total += match.tiles[tileId].towerCount;
  return total;
}

/**
 * Bonus de defensa PASIVA (siempre se suma, haya o no gente defendiendo) que
 * dan las torres terminadas de una facción — ver TOWER_DEFENSE_BONUS arriba.
 */
function towerDefenseBonus(match, faction) {
  return finishedTowerCountForFaction(match, faction) * TOWER_DEFENSE_BONUS;
}

module.exports = {
  resolveTowers,
  towerDefenseBonus,
  finishedTowerCountForFaction,
  TOWER_DEFENSE_BONUS,
  TOWER_MAX_PER_FACTION,
};
