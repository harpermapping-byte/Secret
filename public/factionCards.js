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

  // Medidas de la probeta de industria, en unidades del viewBox del SVG.
  const FLASK_W = 26;
  const FLASK_H = 72;
  const FLASK_BODY_TOP = 16;   // donde acaba el cuello y empieza el cuerpo
  const FLASK_BODY_BOTTOM = 69;
  // El VIEWBOX se queda igual (así no hay que recalcular a mano la docena de
  // coordenadas del cristal/corcho): solo se agranda el TAMAÑO renderizado
  // (atributos width/height), que es lo que de verdad hacía que el relleno y
  // las 4 marcas de nivel casi no se vieran en la barra lateral — a 26x72 la
  // línea de una marca sin alcanzar medía menos de 1px de grosor en pantalla.
  const FLASK_RENDER_SCALE = 1.4;

  /**
   * Probeta medieval (con tapon de corcho) que se va llenando de liquido del
   * color de la faccion segun sube su industria acumulada, con las 4 marcas de
   * los umbrales de mejora. Va en SVG inline — se dibuja nitida a cualquier
   * tamaño y no hace falta ningun asset extra.
   *
   * `thresholds` son los 4 umbrales que manda el servidor para ESA faccion
   * (`faction.industryThresholds`, calculados en server/rules/industry.js —
   * unica fuente de verdad). Van por faccion y no globales porque dependen de
   * cuanta gente tiene cada una: asi la probeta mide "como de bien coopera mi
   * faccion" y es comparable entre facciones de tamaños distintos. El ULTIMO
   * umbral es el que llena la probeta del todo, asi que si se reajustan los
   * numeros, las marcas se recolocan solas sin tocar esto.
   */
  function industryFlask(industry, thresholds, color) {
    const marks = (thresholds || []).slice().sort((a, b) => a - b);
    const max = marks.length ? marks[marks.length - 1] : 0;
    const fillRatio = max > 0 ? Math.max(0, Math.min(1, industry / max)) : 0;

    const bodyH = FLASK_BODY_BOTTOM - FLASK_BODY_TOP;
    const liquidH = bodyH * fillRatio;
    const liquidY = FLASK_BODY_BOTTOM - liquidH;

    const markLines = marks.map((value) => {
      const y = FLASK_BODY_BOTTOM - bodyH * (max > 0 ? value / max : 0);
      const reached = industry >= value;
      return `<line x1="6" y1="${y.toFixed(1)}" x2="20" y2="${y.toFixed(1)}"
                stroke="${reached ? '#8a6a1f' : '#5a4a32'}"
                stroke-width="${reached ? 2 : 1.4}" opacity="${reached ? 1 : 0.8}" />`;
    }).join('');

    // Se ve como tooltip nativo del navegador (el <title> de dentro del SVG):
    // aparece SOLO al poner el ratón encima de la probeta, tal y como se
    // pidió, sin JS de hover aparte.
    const nextMark = marks.find((value) => industry < value);
    const nextTier = nextMark !== undefined ? marks.indexOf(nextMark) + 1 : null;
    const title = nextTier
      ? `Industria: ${industry.toFixed(1)} — faltan ${(nextMark - industry).toFixed(1)} para el nivel ${nextTier}`
      : `Industria: ${industry.toFixed(1)} — las 8 mejoras ya están desbloqueadas`;

    const safeColor = escapeHtml(color);

    return `
      <svg class="industryFlask" viewBox="0 0 ${FLASK_W} ${FLASK_H}" width="${Math.round(FLASK_W * FLASK_RENDER_SCALE)}" height="${Math.round(FLASK_H * FLASK_RENDER_SCALE)}"
           role="img" aria-label="${escapeHtml(title)}">
        <title>${escapeHtml(title)}</title>
        <!-- corcho -->
        <rect x="9" y="0" width="8" height="6" rx="1.5" fill="#8a6238" stroke="#4a331c" stroke-width="1" />
        <!-- cuello -->
        <rect x="10.5" y="5" width="5" height="7" fill="#cfe3ea" opacity=".35" stroke="#4a331c" stroke-width="1" />
        <!-- cuerpo de cristal -->
        <path d="M10.5 12 L10.5 ${FLASK_BODY_TOP} Q4 ${FLASK_BODY_TOP + 3} 4 ${FLASK_BODY_TOP + 12}
                 L4 ${FLASK_BODY_BOTTOM - 5} Q4 ${FLASK_BODY_BOTTOM} 9 ${FLASK_BODY_BOTTOM}
                 L17 ${FLASK_BODY_BOTTOM} Q22 ${FLASK_BODY_BOTTOM} 22 ${FLASK_BODY_BOTTOM - 5}
                 L22 ${FLASK_BODY_TOP + 12} Q22 ${FLASK_BODY_TOP + 3} 15.5 ${FLASK_BODY_TOP} L15.5 12 Z"
              fill="#cfe3ea" opacity=".28" stroke="#4a331c" stroke-width="1.4" stroke-linejoin="round" />
        <!-- liquido: recortado a la silueta del cuerpo para que no se salga -->
        <clipPath id="flaskClip${Math.round(industry * 1000)}${safeColor.replace(/[^a-z0-9]/gi, '')}">
          <path d="M10.5 12 L10.5 ${FLASK_BODY_TOP} Q4 ${FLASK_BODY_TOP + 3} 4 ${FLASK_BODY_TOP + 12}
                   L4 ${FLASK_BODY_BOTTOM - 5} Q4 ${FLASK_BODY_BOTTOM} 9 ${FLASK_BODY_BOTTOM}
                   L17 ${FLASK_BODY_BOTTOM} Q22 ${FLASK_BODY_BOTTOM} 22 ${FLASK_BODY_BOTTOM - 5}
                   L22 ${FLASK_BODY_TOP + 12} Q22 ${FLASK_BODY_TOP + 3} 15.5 ${FLASK_BODY_TOP} L15.5 12 Z" />
        </clipPath>
        ${liquidH > 0 ? `<rect x="3" y="${liquidY.toFixed(1)}" width="20" height="${(liquidH + 1).toFixed(1)}"
              fill="${safeColor}" opacity=".85"
              clip-path="url(#flaskClip${Math.round(industry * 1000)}${safeColor.replace(/[^a-z0-9]/gi, '')})" />` : ''}
        ${markLines}
      </svg>`;
  }

  /**
   * Sistema de vidas (ver rules/shared.js handleTroopWipeout(),
   * match.config.startingLives del panel de admin, docs/ACCIONES.md): un
   * corazón por vida configurada, en rojo las que le quedan a `lives`, en
   * negro ("apagado") las que ya perdió — usado en el roster de Facciones,
   * el panel de Jugadores (public/index.html) y el marcador del mapa
   * (mapRenderer.js, su propia copia porque dibuja en canvas, no en DOM).
   */
  function heartsFor(lives, startingLives) {
    const total = Math.max(startingLives || 0, lives || 0);
    let s = '';
    for (let i = 0; i < total; i++) s += i < (lives || 0) ? '❤️' : '🖤';
    return s;
  }

  function renderFactionCards(container, state) {
    container.innerHTML = '';
    const startingLives = state.startingLives || 3;
    (state.factions || []).forEach((f) => {
      const playersInFaction = (state.players || []).filter((p) => p.factionNumber === f.number);
      const aliveCount = playersInFaction.filter((p) => p.alive).length;
      const color = escapeHtml(f.color);
      const name = escapeHtml(f.name);

      const card = document.createElement('div');
      card.className = 'factionCard';
      card.style.borderLeftColor = f.color;
      card.innerHTML = `
        <div class="factionCardMain">
          <span class="dot" style="background:${color}"></span>
          <span class="fname" data-hover-faction="${f.number}">#${f.number} ${name}</span>
          <span class="fstat">${aliveCount}/${playersInFaction.length} vivos</span>
          <span class="fstat">${f.territoryCount} terr.</span>
          <span class="fstat">industria ${f.industry.toFixed(1)} (+${(f.industryGainedLastRound || 0).toFixed(1)})</span>
          <span class="fstat">${f.killsCaused || 0} bajas causadas</span>
        </div>
        ${industryFlask(f.industry, f.industryThresholds || [], f.color)}
      `;

      const roster = document.createElement('div');
      roster.className = 'rosterMini';
      if (playersInFaction.length === 0) {
        roster.innerHTML = '<span style="opacity:.5">nadie unido todavía</span>';
      } else {
        playersInFaction.forEach((p) => {
          const tag = document.createElement('span');
          tag.className = p.alive ? '' : 'dead';
          const hearts = p.alive ? ` ${heartsFor(p.lives, startingLives)}` : '';
          tag.textContent = `${p.username}${p.unitType === 'knight' ? ' 🐴' : ''}${hearts}`;
          roster.appendChild(tag);
        });
      }

      const wrap = document.createElement('div');
      wrap.appendChild(card);
      wrap.appendChild(roster);
      container.appendChild(wrap);
    });
  }

  window.CondejorgeFactionCards = { renderFactionCards, escapeHtml, heartsFor };
})();
