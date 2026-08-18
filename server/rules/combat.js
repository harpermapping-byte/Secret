'use strict';

const { ACTION_ATTACK, ACTION_DEFEND } = require('../commands');
const { sumRandomPower, applyCasualties } = require('./shared');
const { transferTile, findWeakestBorderTile, factionByNumber } = require('./territory');

// Defensa pasiva minima por casilla controlada, para que nadie quede en 0 absoluto.
// Valor de ejemplo, pendiente de afinar.
const BASE_GARRISON_PER_TERRITORY = 0.3;

/**
 * Resuelve todo el combate de la ronda a la vez: agrupa los ataques que recibe
 * cada faccion (venga de una o varias facciones atacantes) y los compara en un
 * unico combate contra su defensa total. Ver docs/GDD seccion 6 "Combate".
 */
function resolveCombat(match, context) {
  const incomingByDefender = groupIncomingAttacks(match, context);

  for (const [defenderNumber, attackers] of incomingByDefender) {
    const defenderFaction = factionByNumber(match, defenderNumber);
    if (!defenderFaction || defenderFaction.territoryIds.length === 0) continue;

    const totalAttackers = attackers.reduce((sum, a) => sum + a.userIds.length, 0);
    const defenderVotes = context.votesByFactionAndType.get(defenderNumber)[ACTION_DEFEND].length;

    let attackPower = sumRandomPower(totalAttackers) * combatModifier(match, defenderNumber, 'attack');
    let defensePower =
      sumRandomPower(defenderVotes) * combatModifier(match, defenderNumber, 'defense') +
      defenderFaction.territoryIds.length * BASE_GARRISON_PER_TERRITORY;

    if (attackPower > defensePower) {
      // Gana el ataque: baja la faccion defensora y conquista territorio.
      const winningAttacker = attackers.sort((a, b) => b.userIds.length - a.userIds.length)[0];
      applyCasualties(match, context, defenderNumber, Math.round(attackPower - defensePower), winningAttacker.factionNumber);

      const tile = findWeakestBorderTile(match, defenderNumber, winningAttacker.factionNumber);
      if (tile) {
        transferTile(match, tile.id, winningAttacker.factionNumber);
        context.roundEvents.conquests.push({
          tileId: tile.id,
          fromFactionNumber: defenderNumber,
          toFactionNumber: winningAttacker.factionNumber,
          kind: 'attack',
        });
      }

      match.lastAttackerOf[defenderNumber] = winningAttacker.factionNumber;
      for (const attacker of attackers) {
        context.roundEvents.combats.push({
          attackerFactionNumber: attacker.factionNumber,
          defenderFactionNumber: defenderNumber,
          outcome: attacker.factionNumber === winningAttacker.factionNumber ? 'attacker_won' : 'attacker_lost',
        });
      }
    } else {
      // Empate o gana la defensa: las facciones atacantes sufren bajas proporcionales a su aporte.
      const excess = Math.round(defensePower - attackPower);
      for (const attacker of attackers) {
        const share = attacker.userIds.length / totalAttackers;
        applyCasualties(match, context, attacker.factionNumber, Math.round(excess * share), defenderNumber);
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

module.exports = { resolveCombat, BASE_GARRISON_PER_TERRITORY };
