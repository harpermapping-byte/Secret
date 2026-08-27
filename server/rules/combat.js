'use strict';

const { ACTION_ATTACK, ACTION_DEFEND } = require('../commands');
const { sumRandomPower, applyTroopCascadeDamageAndWipeouts, applyTroopCascadeDirectKillAndWipeouts } = require('./shared');
const { transferTile, pickBorderTileToConquer, factionByNumber, checkFactionElimination } = require('./territory');
const { towerDefenseBonus } = require('./towers');
const { alliedFactionsOf } = require('./alliances');
const { wonderDefenseBonus } = require('./wonders');
const { museumDefenseBonus } = require('./bosses');
const { specialAbilityDefenseBonus } = require('./specialAbilities');
const { industryTier7DefenseBonus } = require('./industry');
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
 * Cinco excepciones a lo anterior, todas sumadas tal cual (sin
 * combatModifier) al final del calculo correspondiente:
 * - Las torres (`!torre`, ver rules/towers.js) dan +0.5 de defensa pasiva
 *   CADA UNA, siempre, aunque nadie vote `!defender` esa ronda.
 * - Las maravillas de tipo 'defense' (Ruinas de Numancia/Kebab/Contrato
 *   indefinido, ver rules/wonders.js) dan +4 de defensa pasiva cada una
 *   MIENTRAS la facción las tenga conquistadas (ver rules/wonders.js).
 * - Los museos (trofeo de `!boss`, ver rules/bosses.js) dan +2 de defensa
 *   pasiva cada uno, sin tope.
 * - La habilidad especial "Muralla" (hab6, ver rules/specialAbilities.js)
 *   da +1 de defensa pasiva PERMANENTE en cuanto se activa.
 * - El nivel 7 de industria "Muralla real" (ver rules/industry.js) da OTRO
 *   +1 de defensa pasiva PERMANENTE, acumulable con la habilidad especial
 *   de arriba (son cosas distintas pese al nombre parecido).
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
 *
 * Ganar también cuesta (v0.4.7): antes de esto, solo el bando que PERDÍA la
 * comparación de poder sufría bajas — el que ganaba salía siempre gratis, en
 * los dos sentidos. Ahora el bando ganador TAMBIÉN pierde tropas, solo que
 * menos que el perdedor: `WINNER_LOSS_FACTOR` de las TROPAS (no puntos de
 * poder) que ya perdió el perdedor, matadas con
 * `applyTroopCascadeDirectKillAndWipeouts()` (rules/shared.js) — un número
 * de tropas FIJO, no una cantidad de daño en puntos de poder convertida
 * después a tropas. Por qué no puntos de poder: un bando con mucho stock de
 * tropas "baratas" (AI_TROOP_COMBAT_BONUS=0.1/unidad) puede perder MUCHAS
 * más tropas por un puñado de puntos que el bando perdedor por un margen
 * mucho mayor, si a este último ya casi no le quedaban tropas de antes (tope
 * por disponibilidad, no por la fórmula) — pasó de verdad en pruebas con
 * partidas largas donde un bando llevaba varias rondas perdiendo. Matando un
 * número FIJO de tropas (`floor(tropas_perdidas_por_el_perdedor * factor)`)
 * la relación "el ganador pierde menos que el perdedor" queda garantizada
 * por construcción, sea cual sea el stock de cada bando. El reparto entre
 * varios combatientes de un mismo bando usa el mismo criterio que ya se
 * usaba para repartir las bajas del perdedor entre varios atacantes
 * (`share = sus votantes / total`). Quién es "ganador" se decide por la
 * comparación de PODER (attackPower vs defensePower), no por si al final se
 * conquista la casilla: un ataque que gana el cálculo pero no dejó sin
 * tropas a los defensores ("defender_held") sigue costando a los dos bandos
 * igual que uno que sí conquista.
 */
const WINNER_LOSS_FACTOR = 0.3;

function resolveCombat(match, context) {
  const incomingByDefender = groupIncomingAttacks(match, context);

  for (const [defenderNumber, attackers] of incomingByDefender) {
    const defenderFaction = factionByNumber(match, defenderNumber);
    if (!defenderFaction || defenderFaction.territoryIds.length === 0) continue;

    const attackerUserIds = attackers.flatMap((a) => a.userIds);
    const totalAttackers = attackerUserIds.length;
    // Defensa conjunta de aliadas (ver rules/alliances.js sección 38):
    // mientras dure la alianza, los !defender de la facción aliada cuentan
    // TAMBIÉN en este combate, como si fueran una sola facción — sin dejar
    // de contar en el de la suya propia si también la atacan esta ronda.
    // Duplicados imposibles: un jugador solo puede estar en el DEFEND de su
    // propia facción (o en el de UNA ajena vía !apoyar, que lo mete en el
    // bucket ajeno en vez del suyo, ver tallyActions()).
    const defenderUserIds = [...context.votesByFactionAndType.get(defenderNumber)[ACTION_DEFEND]];
    for (const allyNumber of alliedFactionsOf(match, defenderNumber)) {
      const allyBucket = context.votesByFactionAndType.get(allyNumber);
      if (allyBucket) defenderUserIds.push(...allyBucket[ACTION_DEFEND]);
    }

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
        museumDefenseBonus(defenderFaction) +
        specialAbilityDefenseBonus(defenderFaction) +
        industryTier7DefenseBonus(defenderFaction) -
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

      // El bando ganador (los atacantes) TAMBIÉN paga un coste, repartido
      // proporcionalmente entre las facciones atacantes por su aporte de
      // votantes — ver WINNER_LOSS_FACTOR y applyTroopCascadeDirectKill...()
      // en la cabecera del archivo (número de TROPAS, no puntos de poder).
      const defenderTroopsLostForFactor = troopsBefore - troopsAfter;
      const winnerKillPool = Math.floor(defenderTroopsLostForFactor * WINNER_LOSS_FACTOR);
      const attackerLosses = new Map(); // factionNumber -> { troopsLost, diedCount }
      for (const attacker of attackers) {
        const share = attacker.userIds.length / totalAttackers;
        const rawAttackerKill = Math.round(winnerKillPool * share);
        const result = applyTroopCascadeDirectKillAndWipeouts(match, attacker.userIds, rawAttackerKill);
        if (result.diedUserIds.length > 0) checkFactionElimination(match, context, attacker.factionNumber, defenderNumber);
        attackerLosses.set(attacker.factionNumber, {
          troopsLost: result.troopsBefore - result.troopsAfter,
          diedCount: result.diedUserIds.length,
        });
      }

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
          const loss = attackerLosses.get(attacker.factionNumber);
          context.roundEvents.combats.push({
            attackerFactionNumber: attacker.factionNumber,
            defenderFactionNumber: defenderNumber,
            outcome: 'defender_held',
            attackerTroopsLost: loss.troopsLost,
            attackerDiedCount: loss.diedCount,
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
        const loss = attackerLosses.get(attacker.factionNumber);
        context.roundEvents.combats.push({
          attackerFactionNumber: attacker.factionNumber,
          defenderFactionNumber: defenderNumber,
          outcome: attacker.factionNumber === winningAttacker.factionNumber ? 'attacker_won' : 'attacker_lost',
          tileId: attacker.factionNumber === winningAttacker.factionNumber ? conqueredTileId : null,
          attackerTroopsLost: loss.troopsLost,
          attackerDiedCount: loss.diedCount,
          ...detail,
        });
      }
    } else {
      // Empate o gana la defensa: las facciones atacantes pierden tropas
      // proporcionales a su aporte (cascada igual que arriba) — quien se
      // queda sin ninguna pierde una vida, igual que en la rama de arriba.
      const excess = Math.round(defensePower - attackPower);

      // Primero el bando PERDEDOR (los atacantes), igual que siempre.
      let totalAttackerTroopsLost = 0;
      const attackerResults = new Map(); // factionNumber -> { troopsLost, diedCount }
      for (const attacker of attackers) {
        const share = attacker.userIds.length / totalAttackers;
        const rawDamage = Math.round(excess * share);
        const { diedUserIds, troopsBefore, troopsAfter } = applyTroopCascadeDamageAndWipeouts(match, attacker.userIds, rawDamage);
        if (diedUserIds.length > 0) checkFactionElimination(match, context, attacker.factionNumber, defenderNumber);
        const troopsLost = troopsBefore - troopsAfter;
        totalAttackerTroopsLost += troopsLost;
        attackerResults.set(attacker.factionNumber, { troopsLost, diedCount: diedUserIds.length });
      }

      // El bando ganador (los defensores) TAMBIÉN paga un coste — ver
      // WINNER_LOSS_FACTOR y applyTroopCascadeDirectKill...() en la
      // cabecera del archivo: número de TROPAS (fracción de las que YA
      // perdió el bando atacante), no puntos de poder. Se aplica a la lista
      // conjunta de defensores (propios + aliada, ver defenderUserIds más
      // arriba) de una vez: la cascada ya decide sola qué tropas concretas
      // se pierden dentro de ese grupo.
      const winnerKillPool = Math.floor(totalAttackerTroopsLost * WINNER_LOSS_FACTOR);
      let defenderTroopsLost = 0;
      let defenderDiedCount = 0;
      if (winnerKillPool > 0 && defenderUserIds.length > 0) {
        const result = applyTroopCascadeDirectKillAndWipeouts(match, defenderUserIds, winnerKillPool);
        defenderTroopsLost = result.troopsBefore - result.troopsAfter;
        defenderDiedCount = result.diedUserIds.length;
        if (result.diedUserIds.length > 0) {
          const biggestAttacker = attackers.sort((a, b) => b.userIds.length - a.userIds.length)[0];
          checkFactionElimination(match, context, defenderNumber, biggestAttacker.factionNumber);
        }
      }

      for (const attacker of attackers) {
        const loss = attackerResults.get(attacker.factionNumber);
        context.roundEvents.combats.push({
          attackerFactionNumber: attacker.factionNumber,
          defenderFactionNumber: defenderNumber,
          outcome: 'defender_held',
          attackPower: Math.round(attackPower * 10) / 10,
          defensePower: Math.round(defensePower * 10) / 10,
          attackerTroopsLost: loss.troopsLost,
          attackerDiedCount: loss.diedCount,
          defenderTroopsLost,
          defenderDiedCount,
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
