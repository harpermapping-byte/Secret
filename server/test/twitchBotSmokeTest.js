'use strict';

// Prueba de humo: conecta de verdad al chat de Twitch (lectura anonima) y
// muestra por consola cualquier comando reconocido. Ejecutar con:
// node server/test/twitchBotSmokeTest.js <canal>
// Se corta solo a los 30s si no hay actividad, para no dejar el proceso colgado.

const { connectToChannels } = require('../twitchBot');

const channel = process.argv[2] || 'condejorge';
console.log(`Conectando al chat de #${channel} (lectura anonima)...`);

connectToChannels([channel], ({ userId, username, channel, text }) => {
  console.log(`[#${channel}] ${username} (${userId}): ${text}`);
});

setTimeout(() => {
  console.log('30s sin cerrar el proceso a proposito, Ctrl+C para salir.');
}, 30000);
