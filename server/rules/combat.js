'use strict';

const { ACTION_ATTACK, ACTION_DEFEND } = require('../commands');
const { sumRandomPower, applyCasualties, applyTroopCascadeDamage } = require('./shared');
const { transferTile, pickBorderTileToConquer, factionByNumber, checkFactionElimination } = require('./territory');

/**
 * Resuelve todo el combate de la ronda a la vez: agrupa los ataques que recibe
 * cada faccion (venga de una o varias facciones atacantes) y los compara en un
 * unico combate contra su defensa total. Ver docs/GDD seccion 6 "Combate".
 *
 * El territorio NO tiene defensa pasiva: una faccion a la que nadie defiende
 * con `!defender` esa ronda entra al combate con 0 de defensa, por muchas
 * casillas que tenga. Toda la defensa sale de los usuarios que escriben
 * `!defender` en la Fase de Accion, cada uno aportando su propia tirada
 * (ver COMBAT_RANDOM_MIN/MAX en rules/shared.js).
 */
function resolveCombat(match, context) {
  const incomingByDefender = groupIncomingAttacks(match, context);

  for (const [defenderNumber, attackers] of incomingByDefender) {
    const defenderFaction = factionByNumber(match, defenderNumber);
    if (!defenderFaction || defenderFaction.territoryIds.length === 0) continue;

    const attackerUserIds = attackers.flatMap((a) => a.userIds);
    const totalAttackers = attackerUserIds.length;
    const defenderUserIds = context.votesByFactionAndType.get(defenderNumber)[ACTION_DEFEND];

    // Cada tirada depende de QUIEN vota (soldado o caballero, ver rules/shared.js),
    // no solo de cuantos son.
    const attackPower = sumRandomPower(match, attackerUserIds, 'attack') * combatModifier(match, defenderNumber, 'attack');
    const defensePower = sumRandomPower(match, defenderUserIds, 'defense') * combatModifier(match, defenderNumber, 'defense');

    if (attackPower > defensePower) {
      // Gana el ataque: baja la faccion defensora y conquista territorio.
      // El daño sobrante se reparte primero entre las tropas de IA de los
      // que votaron !defender (caballero->arquero->leva, ver
      // applyTroopCascadeDamage en rules/shared.js) antes de matar
      // jugadores — solo lo que sobra de esa cascada llega a
      // applyCasualties().
      const winningAttacker = attackers.sort((a, b) => b.userIds.length - a.userIds.length)[0];
      const rawDamage = Math.round(attackPower - defensePower);
      const remainingDamage = applyTroopCascadeDamage(match, defenderUserIds, rawDamage);
      applyCasualties(match, context, defenderNumber, remainingDamage, winningAttacker.factionNumber);

      const tile = pickBorderTileToConquer(match, defenderNumber, winningAttacker.factionNumber);
      if (tile) {
        transferTile(match, tile.id, winningAttacker.factionNumber);
        context.roundEvents.conquests.push({
          tileId: tile.id,
          fromFactionNumber: defenderNumber,
          toFactionNumber: winningAttacker.factionNumber,
          kind: 'attack',
        });
      }

      // Si esta bajada de tropas deja a la faccion defensora sin miembros vivos, el resto de su
      // territorio (la casilla de arriba ya no cuenta, se la quedo el atacante) pasa a neutral de
      // golpe en vez de quedarse plantado sin dueño util — ver docs/ACCIONES.md seccion 6.
      checkFactionElimination(match, context, defenderNumber, winningAttacker.factionNumber);

      match.lastAttackerOf[defenderNumber] = winningAttacker.factionNumber;
      for (const attacker of attackers) {
        context.roundEvents.combats.push({
          attackerFactionNumber: attacker.factionNumber,
          defenderFactionNumber: defenderNumber,
          outcome: attacker.factionNumber === winningAttacker.factionNumber ? 'attacker_won' : 'attacker_lost',
        });
      }
    } else {
      // Empate o gana la defensa: las facciones atacantes sufren bajas
      // proporcionales a su aporte — igual que arriba, primero cascada de
      // tropas de los votantes de ESE ataque, solo el resto mata jugadores.
      const excess = Math.round(defensePower - attackPower);
      for (const attacker of attackers) {
        const share = attacker.userIds.length / totalAttackers;
        const rawDamage = Math.round(excess * share);
        const remainingDamage = applyTroopCascadeDamage(match, attacker.userIds, rawDamage);
        applyCasualties(match, context, attacker.factionNumber, remainingDamage, defenderNumber);
        checkFactionElimination(match, context, attacker.factionNumber, defenderNumber);
        context.roundEvents.combats.push({
          attackerFactionNumber: attacker.factionNumber,
          defenderFactionNumber: defenderNumber,
          outcome: 'defender_held',
        });
      }
    }
  }

  // Facciones que no recibieron ningun ataque esta ronda: no tuvieron atacante, se limpia el registro.
  for (const faction of match.factions) {
    if (!incomingByDefender.has(faction.number)) match.lastAttackerOf[faction.number] = null;
  }
}

function groupIncomingAttacks(match, context) {
  const incomingByDefender = new Map();
  for (const attackerFaction of match.factions) {
    const attackVotes = context.votesByFactionAndType.get(attackerFaction.number)[ACTION_ATTACK];
    for (const [defenderNumber, userIds] of attackVotes) {
      if (userIds.length === 0) continue;
      if (!incomingByDefender.has(defenderNumber)) incomingByDefender.set(defenderNumber, []);
      incomingByDefender.get(defenderNumber).push({ factionNumber: attackerFaction.number, userIds });
    }
  }
  return incomingByDefender;
}

/** Modificadores temporales de combate (Escudo/Frenesi) puestos por resolveSpecialAbilities. */
function combatModifier(match, factionNumber, kind) {
  const mod = match.combatModifiers?.[factionNumber];
  if (!mod) return 1;
  if (kind === 'defense' && mod.defenseBonusPercent) return 1 + mod.defenseBonusPercent / 100;
  if (kind === 'attack' && mod.attackBonusPercent) return 1 + mod.attackBonusPercent / 100;
  return 1;
}

module.exports = { resolveCombat };
