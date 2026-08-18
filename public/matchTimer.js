'use strict';

/**
 * Cuenta atrás del timer de fase — único módulo del proyecto que sabe
 * formatear "cuánto queda", usado tanto por `public/index.html` como por
 * `admin/index.html` (servido también en `/matchTimer.js` desde el panel de
 * admin, igual que `mapRenderer.js`/`factionCards.js`). Ver docs/ACCIONES.md
 * sección 6 "Timer de fase (pausa)".
 *
 * Uso:
 *   const matchTimer = CondejorgeMatchTimer.createMatchTimerTracker();
 *   setInterval(() => { el.textContent = matchTimer.formatRemaining(lastState); }, 250);
 *
 * Por qué hace falta este módulo y no solo `state.timerEndsAt - Date.now()`:
 * cuando el admin pausa la ronda (`admin:pause`), el servidor dejar de mover
 * `timerEndsAt` — se queda congelado en el instante en que se pausó (ver
 * `pauseTimer()` en `server/gameEngine.js`). Si el cliente sigue calculando
 * "restante = timerEndsAt - ahora" sin más, la cuenta atrás cae a 00:00 sola
 * unos segundos después de pausar, aunque la ronda esté realmente parada —
 * eso es lo que hacía parecer que "pausar no funciona". Este módulo, en
 * cuanto ve `state.timerPaused === true` por primera vez, congela el valor
 * que tocaba en ese instante y lo repite tal cual mientras siga en pausa.
 */
(function () {
  function createMatchTimerTracker() {
    let frozenRemainingMs = null; // valor congelado mientras dura la pausa actual
    let wasPaused = false;

    function formatRemaining(state) {
      if (!state || !state.timerEndsAt) {
        wasPaused = false;
        frozenRemainingMs = null;
        return '--:--';
      }

      if (state.timerPaused) {
        if (!wasPaused) {
          frozenRemainingMs = Math.max(0, state.timerEndsAt - Date.now());
          wasPaused = true;
        }
        return `${formatMs(frozenRemainingMs)} ⏸`;
      }

      wasPaused = false;
      frozenRemainingMs = null;
      return formatMs(Math.max(0, state.timerEndsAt - Date.now()));
    }

    return { formatRemaining };
  }

  function formatMs(ms) {
    const seconds = Math.ceil(ms / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  window.CondejorgeMatchTimer = { createMatchTimerTracker };
})();
