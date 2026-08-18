'use strict';

/**
 * Única función del proyecto que dibuja las tarjetas de facción (nombre,
 * color, jugadores vivos, territorios, industria, bajas causadas, roster en
 * miniatura) — la usan tanto la web pública (panel "🏳️ Facciones") como el
 * panel de admin (panel "📋 Facciones") para no tener dos implementaciones
 * del mismo bloque visual. Estilos en `public/shared.css`
 * (`.factionCards`/`.factionCard`/`.rosterMini`). Ver docs/ACCIONES.md
 * sección 6 para la forma de `state.factions`/`state.players`.
 *
 * Uso: CondejorgeFactionCards.renderFactionCards(containerEl, state)
 */
(function () {
  /**
   * El nombre de faccion lo escribe quien tenga ADMIN_PASSWORD y se manda tal
   * cual a todos los espectadores conectados (state:public/state:admin) — sin
   * escapar, un nombre de faccion tipo `<img src=x onerror=...>` ejecutaria
   * script en el navegador de cualquiera que tenga la web abierta. Unica
   * funcion de escape del proyecto: la usan tambien public/index.html y
   * admin/index.html (ver window.CondejorgeFactionCards.escapeHtml) para no
   * repetir esta misma logica en cada sitio donde se interpola texto dentro
   * de innerHTML.
   */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function renderFactionCards(container, state) {
    container.innerHTML = '';
    (state.factions || []).forEach((f) => {
      const playersInFaction = (state.players || []).filter((p) => p.factionNumber === f.number);
      const aliveCount = playersInFaction.filter((p) => p.alive).length;
      const color = escapeHtml(f.color);
      const name = escapeHtml(f.name);

      const card = document.createElement('div');
      card.className = 'factionCard';
      card.style.borderLeftColor = f.color;
      card.innerHTML = `
        <span class="dot" style="background:${color}"></span>
        <span class="fname">#${f.number} ${name}</span>
        <span class="fstat">${aliveCount}/${playersInFaction.length} vivos</span>
        <span class="fstat">${f.territoryCount} terr.</span>
        <span class="fstat">industria ${f.industry.toFixed(1)} (+${(f.industryGainedLastRound || 0).toFixed(1)})</span>
        <span class="fstat">${f.killsCaused || 0} bajas causadas</span>
      `;

      const roster = document.createElement('div');
      roster.className = 'rosterMini';
      if (playersInFaction.length === 0) {
        roster.innerHTML = '<span style="opacity:.5">nadie unido todavía</span>';
      } else {
        playersInFaction.forEach((p) => {
          const tag = document.createElement('span');
          tag.className = p.alive ? '' : 'dead';
          tag.textContent = `${p.username}${p.unitType === 'tank' ? ' 🛡' : ''}`;
          roster.appendChild(tag);
        });
      }

      const wrap = document.createElement('div');
      wrap.appendChild(card);
      wrap.appendChild(roster);
      container.appendChild(wrap);
    });
  }

  window.CondejorgeFactionCards = { renderFactionCards, escapeHtml };
})();
