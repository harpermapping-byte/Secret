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

  const newFaction = factionByNumber(match, newOwnerFactionNumber);
  newFaction.territoryIds.push(tileId);
}

/** Devuelve una casilla a neutral (sin dueño), hermana de `transferTile` para el caso "sin dueño nuevo". */
function neutralizeTile(match, tileId) {
  const tile = match.tiles[tileId];
  const previousOwner = tile.ownerFactionNumber;

  if (previousOwner != null) {
    const previousFaction = factionByNumber(match, previousOwner);
    previousFaction.territoryIds = previousFaction.territoryIds.filter((id) => id !== tileId);
  }

  tile.ownerFactionNumber = null;
  tile.neutral = true;
}

/**
 * true si a la faccion le queda al menos un jugador vivo. Privada de este
 * archivo (solo la usa `checkFactionElimination` de aqui abajo) — no se
 * exporta para no tener dos formas de comprobar lo mismo en el proyecto.
 */
function factionHasLivingPlayers(match, factionNumber) {
  for (const player of match.players.values()) {
    if (player.factionNumber === factionNumber && player.alive) return true;
  }
  return false;
}

/**
 * Unico punto del proyecto que comprueba y resuelve "esta faccion se ha
 * quedado sin miembros vivos": si es asi, todo el territorio que le quede
 * (si el combate ya le quito una casilla para el atacante antes de llamar
 * aqui, esa ya no esta en su `territoryIds`) pasa a neutral de golpe, para
 * que cualquier otra faccion pueda tomarlo por separado — no se autoasimila
 * entero a quien dio el golpe final, ver docs/ACCIONES.md seccion 6
 * "Eliminacion de facciones". Llamada tras CUALQUIER `applyCasualties()` que
 * pueda dejar a una faccion a cero (combate normal, Bombardeo, Operacion
 * especial) — no hace nada si a la faccion todavia le queda algun jugador
 * vivo, o si ya no le quedaba territorio que neutralizar.
 */
function checkFactionElimination(match, context, factionNumber, eliminatedByFactionNumber) {
  if (factionHasLivingPlayers(match, factionNumber)) return;
  const faction = factionByNumber(match, factionNumber);
  if (!faction || faction.territoryIds.length === 0) return;

  [...faction.territoryIds].forEach((tileId) => neutralizeTile(match, tileId));
  context.roundEvents.eliminations.push({ factionNumber, eliminatedByFactionNumber });
}

/**
 * Elige, al azar, una casilla propia de defendingFactionNumber que sea
 * frontera con attackingFactionNumber (es decir, tenga al menos una casilla
 * vecina de attackingFactionNumber) para que el ataque ganador se la
 * quede. No hay ningun concepto de "guarnicion" o "punto mas debil" que
 * distinga una casilla fronteriza de otra en esta v1 (ver docs/GDD seccion 6
 * "Combate") — cualquiera de ellas es un blanco igual de valido, asi que se
 * sortea entre todas en vez de fingir una prioridad que no existe.
 */
function pickBorderTileToConquer(match, defendingFactionNumber, attackingFactionNumber) {
  const candidates = match.tiles.filter(
    (tile) =>
      tile.ownerFactionNumber === defendingFactionNumber &&
      tile.neighborIds.some((id) => match.tiles[id].ownerFactionNumber === attackingFactionNumber)
  );
  return pickRandomTile(candidates);
}

/** Elige, al azar, una casilla neutral adyacente al territorio de una faccion, para !expansion. */
function pickExpandableNeutralTile(match, factionNumber) {
  const candidates = match.tiles.filter(
    (tile) => tile.neutral && tile.neighborIds.some((id) => match.tiles[id].ownerFactionNumber === factionNumber)
  );
  return pickRandomTile(candidates);
}

function pickRandomTile(candidates) {
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** true si factionA tiene alguna casilla adyacente a una casilla de factionB. */
function factionsAreAdjacent(match, factionNumberA, factionNumberB) {
  return match.tiles.some(
    (tile) =>
      tile.ownerFactionNumber === factionNumberA &&
      tile.neighborIds.some((id) => match.tiles[id].ownerFactionNumber === factionNumberB)
  );
}

/** Unica funcion del proyecto para buscar una faccion por su numero dentro de una partida ya creada. */
function factionByNumber(match, number) {
  return match.factions.find((f) => f.number === number);
}

module.exports = {
  transferTile,
  neutralizeTile,
  checkFactionElimination,
  pickBorderTileToConquer,
  pickExpandableNeutralTile,
  factionsAreAdjacent,
  factionByNumber,
};
