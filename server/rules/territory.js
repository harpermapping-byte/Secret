'use strict';

/** Traspasa una casilla a una nueva faccion, manteniendo tiles y territoryIds sincronizados. */
function transferTile(match, tileId, newOwnerFactionNumber) {
  const tile = match.tiles[tileId];
  const previousOwner = tile.ownerFactionNumber;

  if (previousOwner != null) {
    const previousFaction = factionByNumber(match, previousOwner);
    previousFaction.territoryIds = previousFaction.territoryIds.filter((id) => id !== tileId);
  }

  tile.ownerFactionNumber = newOwnerFactionNumber;
  tile.neutral = false;
  tile.garrison = 0;

  const newFaction = factionByNumber(match, newOwnerFactionNumber);
  newFaction.territoryIds.push(tileId);
}

/** Casilla propia de defendingFactionNumber, adyacente a attackingFactionNumber, con menos guarnicion. */
function findWeakestBorderTile(match, defendingFactionNumber, attackingFactionNumber) {
  const candidates = match.tiles.filter(
    (tile) =>
      tile.ownerFactionNumber === defendingFactionNumber &&
      tile.neighborIds.some((id) => match.tiles[id].ownerFactionNumber === attackingFactionNumber)
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.garrison - b.garrison)[0];
}

/** Casilla neutral adyacente al territorio de una faccion, para !expansion. */
function findExpandableNeutralTile(match, factionNumber) {
  const candidates = match.tiles.filter(
    (tile) => tile.neutral && tile.neighborIds.some((id) => match.tiles[id].ownerFactionNumber === factionNumber)
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.garrison - b.garrison)[0];
}

/** true si factionA tiene alguna casilla adyacente a una casilla de factionB. */
function factionsAreAdjacent(match, factionNumberA, factionNumberB) {
  return match.tiles.some(
    (tile) =>
      tile.ownerFactionNumber === factionNumberA &&
      tile.neighborIds.some((id) => match.tiles[id].ownerFactionNumber === factionNumberB)
  );
}

function factionByNumber(match, number) {
  return match.factions.find((f) => f.number === number);
}

module.exports = { transferTile, findWeakestBorderTile, findExpandableNeutralTile, factionsAreAdjacent };
