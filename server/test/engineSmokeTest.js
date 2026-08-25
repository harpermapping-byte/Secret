'use strict';

// Prueba de humo sin dependencias externas: ejercita el motor completo
// (Fase 0 -> Reclutamiento -> varias rondas) simulando comandos de chat
// directamente, sin bot ni WebSocket. Ejecutar con: node server/test/engineSmokeTest.js

const engine = require('../gameEngine');

function log(title) {
  const s = engine.getPublicState();
  console.log(`\n--- ${title} ---`);
  console.log('fase:', s.phase, '| ronda:', s.round);
  console.log(
    'facciones:',
    s.factions.map((f) => `#${f.number} ${f.name} territorios=${f.territoryCount} industria=${f.industry.toFixed(1)}`)
  );
  console.log(
    'jugadores:',
    s.players.map((p) => `${p.username}(f${p.factionNumber}${p.alive ? '' : ',muerto'})`)
  );
  if (s.summaryBlocks.length) console.log('resumen:', JSON.stringify(s.summaryBlocks));
  if (s.winnerFactionNumber) console.log('GANADOR: faccion', s.winnerFactionNumber);
}

engine.createMatch({
  factions: [
    { name: 'Halcones', color: '#e63946' },
    { name: 'Lobos', color: '#457b9d' },
    { name: 'Cuervos', color: '#2a9d8f' },
  ],
  channels: ['condejorge'],
  map: { tileCount: 18, mode: 'neutral' },
  alliancesEnabled: true,
  // Habilidad especial ya no se elige por facción (ver rules/specialAbilities.js
  // sección 35 de docs/ACCIONES.md): se reparte sola al azar entre las 6 del
  // catálogo si este interruptor global está activo.
  specialAbilitiesEnabled: true,
});

engine.startMatch();
log('Tras iniciar partida (Reclutamiento)');

// Simula union de jugadores por chat
engine.handleChatCommand('u1', 'Pani', 'condejorge', '!faccion1');
engine.handleChatCommand('u2', 'Rulo', 'condejorge', '!faccion1');
engine.handleChatCommand('u3', 'Nea', 'condejorge', '!faccion2');
engine.handleChatCommand('u4', 'Bricio', 'condejorge', '!faccion2');
engine.handleChatCommand('u5', 'Kaze', 'condejorge', '!faccion3');
engine.handleChatCommand('u6', 'Toni', 'condejorge', '!faccion3');

engine.forceAdvancePhase(); // cierra reclutamiento -> paron del esqueleto ("primera ronda")
engine.forceAdvancePhase(); // salta el paron -> Fase de Accion
log('Ronda 1 - Fase de Accion abierta');

// Ronda 1: todos producen industria
['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].forEach((id) => engine.handleChatCommand(id, id, 'condejorge', '!industria'));
engine.forceAdvancePhase(); // cierra accion -> resuelve -> paron del esqueleto ("resumen ronda")
engine.forceAdvancePhase(); // salta el paron -> Resumen
log('Ronda 1 resuelta');

engine.forceAdvancePhase(); // Resumen -> paron del esqueleto (siguiente ronda)
engine.forceAdvancePhase(); // salta el paron -> Ronda 2 Accion
log('Ronda 2 - Fase de Accion abierta');

// Ronda 2: faccion 1 ataca a faccion 2, faccion 3 defiende
engine.handleChatCommand('u1', 'Pani', 'condejorge', '!ataque 2');
engine.handleChatCommand('u2', 'Rulo', 'condejorge', '!ataque 2');
engine.handleChatCommand('u3', 'Nea', 'condejorge', '!defender');
engine.handleChatCommand('u4', 'Bricio', 'condejorge', '!defender');
engine.handleChatCommand('u5', 'Kaze', 'condejorge', '!industria');
engine.handleChatCommand('u6', 'Toni', 'condejorge', '!expansion');
engine.forceAdvancePhase(); // cierra accion -> resuelve -> paron del esqueleto
engine.forceAdvancePhase(); // salta el paron -> Resumen
log('Ronda 2 resuelta');

engine.endMatch(); // limpia el timer pendiente de Fase de Resumen para que el proceso pueda terminar
process.exit(0);
