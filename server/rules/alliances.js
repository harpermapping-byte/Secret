'use strict';

const { ACTION_ATTACK, ACTION_ALLIANCE } = require('../commands');

/**
 * Alianzas por pacto MUTUO de varios turnos (ver docs/ACCIONES.md sección 38).
 *
 * Ya no existe la "alianza de una ronda" unilateral: para que se forme una
 * alianza hace falta que LAS DOS facciones se voten mutuamente `!alianza` en
 * la MISMA Fase de Acción (cada una superando el umbral de porcentaje de
 * siempre, `config.thresholds.alliancePercent`, dentro de su propia facción).
 * Si solo una de las dos lo hace, no pasa nada: la oferta se queda en el aire
 * y los votantes no pierden el turno (actuaron de buena fe — a diferencia de
 * un voto de alianza que ni siquiera llega al umbral de su facción, que sigue
 * anulando el turno de esos votantes como siempre).
 *
 * Una alianza formada dura `config.allianceDurationRounds` rondas (panel de
 * admin, por defecto 5) y mientras esté activa:
 * - Las dos facciones NO pueden atacarse entre sí: los votos de `!ataque`
 *   contra tu aliada se anulan (el votante pierde el turno, igual que antes).
 * - Defienden como UNA SOLA facción: si atacan a una, los `!defender` de la
 *   otra cuentan también en ese combate (ver alliedFactionsOf() usado por
 *   rules/combat.js) — sin cambiar de bando ni mover territorio.
 * Al agotarse las rondas la alianza expira sola y vuelven a ser facciones
 * completamente independientes (pueden volver a pactarse más adelante).
 *
 * Estado: match.activeAlliances es un Map de "A-B" (A<B) -> número de la
 * ÚLTIMA ronda en la que la alianza sigue activa (expiresAfterRound). Se
 * forma en la resolución de la ronda R con expiresAfterRound = R + duración,
 * así que protege el resto de la ronda R (un !ataque simultáneo al pacto ya
 * queda anulado) y las `duración` rondas siguientes completas.
 *
 * Muta: match.activeAlliances, context.forceInactive,
 *       context.roundEvents.newAlliances (para el popup del cliente).
 */
function resolveAlliances(match, context) {
  // 1) Expirar alianzas viejas ANTES de mirar los votos de esta ronda.
  for (const [key, expiresAfterRound] of match.activeAlliances) {
    if (match.round > expiresAfterRound) match.activeAlliances.delete(key);
  }

  if (!match.config.alliancesEnabled) return;

  const thresholdPercent = match.config.thresholds.alliancePercent;

  // 2) Ofertas de esta ronda que superan el umbral dentro de su facción
  //    ("A->B"). Las que NO llegan al umbral anulan el turno de sus votantes,
  //    igual que siempre.
  const passedOffers = new Set();
  for (const faction of match.factions) {
    const allianceVotes = context.votesByFactionAndType.get(faction.number)[ACTION_ALLIANCE];
    for (const [targetNumber, userIds] of allianceVotes) {
      const activeCount = context.activePlayerCountByFaction.get(faction.number) || 0;
      const percent = activeCount > 0 ? (userIds.length / activeCount) * 100 : 0;
      if (percent >= thresholdPercent) {
        passedOffers.add(`${faction.number}->${targetNumber}`);
      } else {
        userIds.forEach((userId) => context.forceInactive.add(userId));
      }
    }
  }

  // 3) Pacto mutuo: A ofreció a B y B ofreció a A en esta misma ronda.
  for (const offer of passedOffers) {
    const [a, b] = offer.split('->').map(Number);
    if (!passedOffers.has(`${b}->${a}`)) continue;
    const key = pairKey(a, b);
    if (match.activeAlliances.has(key)) continue; // ya eran aliadas, el re-voto no reinicia el contador
    match.activeAlliances.set(key, match.round + match.config.allianceDurationRounds);
    context.roundEvents.newAlliances.push({
      factionA: Math.min(a, b),
      factionB: Math.max(a, b),
      durationRounds: match.config.allianceDurationRounds,
    });
  }

  // 4) Anular ataques entre aliadas (pactos recién formados incluidos).
  for (const faction of match.factions) {
    const attackVotes = context.votesByFactionAndType.get(faction.number)[ACTION_ATTACK];
    for (const [targetNumber, userIds] of [...attackVotes.entries()]) {
      if (factionsAreAllied(match, faction.number, targetNumber)) {
        userIds.forEach((userId) => context.forceInactive.add(userId));
        attackVotes.delete(targetNumber);
      }
    }
  }
}

/** ¿Están `a` y `b` aliadas AHORA MISMO (alianza sin expirar)? */
function factionsAreAllied(match, a, b) {
  const expiresAfterRound = match.activeAlliances.get(pairKey(a, b));
  return expiresAfterRound !== undefined && match.round <= expiresAfterRound;
}

/** Números de facción aliadas de `factionNumber` ahora mismo (puede haber varias). */
function alliedFactionsOf(match, factionNumber) {
  const allies = [];
  for (const [key, expiresAfterRound] of match.activeAlliances) {
    if (match.round > expiresAfterRound) continue;
    const [a, b] = key.split('-').map(Number);
    if (a === factionNumber) allies.push(b);
    else if (b === factionNumber) allies.push(a);
  }
  return allies;
}

function pairKey(a, b) {
  return [a, b].sort((x, y) => x - y).join('-');
}

module.exports = { resolveAlliances, factionsAreAllied, alliedFactionsOf };
