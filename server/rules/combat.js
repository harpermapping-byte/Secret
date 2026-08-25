'use strict';

const { ACTION_ATTACK, ACTION_DEFEND } = require('../commands');
const { sumRandomPower, applyTroopCascadeDamageAndWipeouts } = require('./shared');
const { transferTile, pickBorderTileToConquer, factionByNumber, checkFactionElimination } = require('./territory');
const { towerDefenseBonus } = require('./towers');
const { wonderDefenseBonus } = require('./wonders');
const { museumDefenseBonus } = require('./bosses');
const { rainDefensePenalty } = require('./weather');

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
 *
 * Cuatro excepciones a lo anterior, todas sumadas tal cual (sin
 * combatModifier) al final del calculo correspondiente:
 * - Las torres (`!torre`, ver rules/towers.js) dan +0.5 de defensa pasiva
 *   CADA UNA, siempre, aunque nadie vote `!defender` esa ronda.
 * - Las maravillas de tipo 'defense' (Ruinas de Numancia/Kebab/Contrato
 *   indefinido, ver rules/wonders.js) dan +4 de defensa pasiva cada una
 *   MIENTRAS la facción posea la casilla en la que salieron.
 * - Los museos (trofeo de `!boss`, ver rules/bosses.js) dan +2 de defensa
 *   pasiva cada uno, sin tope.
 *
 * Combate JUGADOR contra JUGADOR (esta función — !dungeon/!boss/!conquista
 * son combates aparte contra guarnición neutral, con su propia resolución en
 * rules/structures.js/rules/bosses.js, mismo sistema de vidas de abajo pero
 * en su propio archivo): que el atacante GANE la comparación de poder no
 * basta por sí solo para conquistar: solo se lleva la casilla si además deja
 * a los defensores (los que votaron `!defender`) sin NINGUNA tropa — si
 * alguno conserva aunque sea una, la defensa aguanta y el territorio no
 * cambia de dueño, aunque haya ganado el cálculo de poder por poco.
 *
 * Sistema de vidas (ver `handleTroopWipeout()`/`applyTroopCascadeDamageAndWipeouts()`
 * en rules/shared.js, `match.config.startingLives` del panel de admin): quien
 * se queda sin NINGUNA tropa en este combate (atacante o defensor, gane o
 * pierda su bando) pierde una vida y reaparece con 0 tropas — solo si esa
 * era su última vida es la muerte real de siempre (dispara
 * `checkFactionElimination()`). Esto pasa igual en ataque que en defensa: no
 * hace falta perder la casilla para perder una vida, ni al revés.
 */
function resolveCombat(match, context) {
  const incomingByDefender = groupIncomingAttacks(match, context);

  for (const [defenderNumber, attackers] of incomingByDefender) {
    const defenderFaction = factionByNumber(match, defenderNumber);
    if (!defenderFaction || defenderFaction.territoryIds.length === 0) continue;

    const attackerUserIds = attackers.flatMap((a) => a.userIds);
    const totalAttackers = attackerUserIds.length;
    const defenderUserIds = context.votesByFactionAndType.get(defenderNumber)[ACTION_DEFEND];

    // Cada tirada depende de QUIEN vota (soldado o caballero, ver
    // rules/shared.js) — incluida su tropa especial si la lleva, ya integrada
    // en sumRandomPower() como un tipo de tropa más (ver SPECIAL_TROOP_COMBAT_BONUS):
    // solo cuenta si ESE jugador vota !ataque/!defender, igual que aiTroops/
    // archerTroops/cavalryTroops.
    const attackPower =
      sumRandomPower(match, attackerUserIds, 'attack') * combatModifier(match, defenderNumber, 'attack');
    const defensePower = Math.max(
      0,
      sumRandomPower(match, defenderUserIds, 'defense') * combatModifier(match, defenderNumber, 'defense') +
        towerDefenseBonus(match, defenderFaction) +
        wonderDefenseBonus(match, defenderFaction) +
        museumDefenseBonus(defenderFaction) -
        rainDefensePenalty(match) // clima: lluvia resta -2 de defensa PvP esta ronda, ver rules/weather.js
    );

    if (attackPower > defensePower) {
      // Gana el ataque: el daño se reparte entre las tropas de los que
      // votaron !defender (caballero->arquero->leva->especial, ver
      // applyTroopCascadeDamage en rules/shared.js) — quien se queda sin
      // NINGUNA con este golpe pierde una vida (ver cabecera de este
      // archivo). Solo se conquista si eso deja a los defensores sin
      // NINGUNA tropa (o si no defendió nadie): si a alguno le queda
      // aunque sea una, la defensa aguanta pese a haber "ganado" el
      // cálculo de poder.
      const winningAttacker = attackers.sort((a, b) => b.userIds.length - a.userIds.length)[0];
      const rawDamage = Math.round(attackPower - defensePower);
      const { diedUserIds, troopsBefore, troopsAfter } = applyTroopCascadeDamageAndWipeouts(match, defenderUserIds, rawDamage);
      if (diedUserIds.length > 0) checkFactionElimination(match, context, defenderNumber, winningAttacker.factionNumber);
      const defendersWiped = defenderUserIds.length === 0 || totalRemainingTroops(match, defenderUserIds) === 0;
      // Detalle para la Fase de Resolución (ver gameEngine.js
      // buildResolutionEvents()) — no lo usa nada de la lógica de arriba,
      // solo lo lee el cliente para el popup de resultado.
      const detail = {
        attackPower: Math.round(attackPower * 10) / 10,
        defensePower: Math.round(defensePower * 10) / 10,
        defenderTroopsLost: troopsBefore - troopsAfter,
        defenderDiedCount: diedUserIds.length,
      };

      if (!defendersWiped) {
        for (const attacker of attackers) {
          context.roundEvents.combats.push({
            attackerFactionNumber: attacker.factionNumber,
            defenderFactionNumber: defenderNumber,
            outcome: 'defender_held',
            ...detail,
          });
        }
        continue;
      }

      let conqueredTileId = null;
      const tile = pickBorderTileToConquer(match, defenderNumber, winningAttacker.factionNumber);
      if (tile) {
        conqueredTileId = tile.id;
        transferTile(match, tile.id, winningAttacker.factionNumber);
        context.roundEvents.conquests.push({
          tileId: tile.id,
          fromFactionNumber: defenderNumber,
          toFactionNumber: winningAttacker.factionNumber,
          conquestKind: 'attack',
        });
      }

      match.lastAttackerOf[defenderNumber] = winningAttacker.factionNumber;
      for (const attacker of attackers) {
        context.roundEvents.combats.push({
          attackerFactionNumber: attacker.factionNumber,
          defenderFactionNumber: defenderNumber,
          outcome: attacker.factionNumber === winningAttacker.factionNumber ? 'attacker_won' : 'attacker_lost',
          tileId: attacker.factionNumber === winningAttacker.factionNumber ? conqueredTileId : null,
          ...detail,
        });
      }
    } else {
      // Empate o gana la defensa: las facciones atacantes pierden tropas
      // proporcionales a su aporte (cascada igual que arriba) — quien se
      // queda sin ninguna pierde una vida, igual que en la rama de arriba.
      const excess = Math.round(defensePower - attackPower);
      for (const attacker of attackers) {
        const share = attacker.userIds.length / totalAttackers;
        const rawDamage = Math.round(excess * share);
        const { diedUserIds, troopsBefore, troopsAfter } = applyTroopCascadeDamageAndWipeouts(match, attacker.userIds, rawDamage);
        if (diedUserIds.length > 0) checkFactionElimination(match, context, attacker.factionNumber, defenderNumber);
        context.roundEvents.combats.push({
          attackerFactionNumber: attacker.factionNumber,
          defenderFactionNumber: defenderNumber,
          outcome: 'defender_held',
          attackPower: Math.round(attackPower * 10) / 10,
          defensePower: Math.round(defensePower * 10) / 10,
          attackerTroopsLost: troopsBefore - troopsAfter,
          attackerDiedCount: diedUserIds.length,
        });
      }
    }
  }

  // Facciones que no recibieron ningun ataque esta ronda: no tuvieron atacante, se limpia el registro.
  for (const faction of match.factions) {
    if (!incomingByDefender.has(faction.number)) match.lastAttackerOf[faction.number] = null;
  }
}

/** Tropas (los 4 tipos juntos) que quedan entre TODOS los `userIds` dados, sumadas. */
function totalRemainingTroops(match, userIds) {
  let total = 0;
  for (const userId of userIds) {
    const player = match.players.get(userId);
    if (!player) continue;
    total += (player.aiTroops || 0) + (player.archerTroops || 0) + (player.cavalryTroops || 0) + (player.specialTroops || 0);
  }
  return total;
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
