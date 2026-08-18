# Condejorge Wars — demo v1

Esqueleto jugable del juego de facciones para el canal de Condejorge. Ver `docs/GDD_Condejorge_v1.md` (diseño) y `docs/ACCIONES.md` (biblioteca de funciones) para el contexto completo.

Esta primera demo usa **placeholders gráficos** (formas y colores, sin arte final) y está construida **sin dependencias externas** — no hace falta `npm install`, solo tener Node.js instalado (versión 22 o superior).

## Cómo arrancarlo

1. Abre una terminal en esta carpeta.
2. Ejecuta:
   ```
   npm start
   ```
3. Verás algo como:
   ```
   Condejorge Wars escuchando en http://localhost:8080
   Panel admin: http://localhost:8080/admin (contraseña: condejorge-demo)
   ```
4. Abre dos pestañas del navegador:
   - `http://localhost:8080/admin` — panel de admin (usa la contraseña de arriba, o cambia la variable de entorno `ADMIN_PASSWORD` antes de arrancar).
   - `http://localhost:8080` — la web pública (el tablero).

## Cómo probarlo con el chat de Condejorge

1. En el panel de admin, rellena las facciones (nombre y color), pon el canal de Twitch a escuchar (`condejorge`, sin la almohadilla), elige el tamaño de mapa y pulsa **Crear partida**.
2. Pulsa **Iniciar partida**. En este momento el bot se conecta de verdad al chat de Twitch de ese canal (funciona aunque el streamer esté offline, ya que es solo el chat del canal).
3. Ve al chat de Twitch de Condejorge (o el canal que hayas puesto) y escribe `!faccion1` (o el número de la facción que quieras). Deberías verte aparecer como jugador en la web pública en tiempo real.
4. Durante la Fase de Acción, prueba `!industria`, `!ataque 2`, `!defender`, `!expansion`, `!especial`.
5. Desde el panel de admin puedes pausar/reanudar el timer, pasar de ronda manualmente, o terminar la partida.

## Ponerlo online para testear con más gente (Render, gratis)

Esto ya no es local: sirve para que cualquier persona con el link pueda entrar a la web pública, y para que otro streamer/tester entre al panel de admin con la contraseña. Usamos **Render** porque tiene un plan gratuito sin pedir tarjeta y soporta WebSockets (lo único que hace falta para este proyecto). Ojo con una cosa: el plan gratis "duerme" el servidor tras 15 minutos sin tráfico y tarda ~1 minuto en despertar con la siguiente visita — para una sesión de test quedando con gente a una hora concreta no es problema, simplemente abre tú la web un par de minutos antes.

Esto no requiere `npm install` ni tarjeta de crédito, pero sí requiere subir el código a GitHub (Render despliega desde un repositorio Git). Pasos:

1. **Sube el proyecto a GitHub** (tienes que hacerlo tú, es tu cuenta):
   - Si no tienes cuenta de GitHub, créate una gratis en github.com.
   - Crea un repositorio nuevo (puede ser público o privado), por ejemplo `condejorge-wars`.
   - Sube la carpeta `condejorge-wars` (todo su contenido, incluida esta vez `render.yaml` y `.node-version`) a ese repositorio. Puedes hacerlo sin usar comandos de git: en la página del repo, botón "Add file" → "Upload files", y arrastras ahí toda la carpeta descomprimida.

2. **Crea el servicio en Render** (también tienes que hacerlo tú, es tu cuenta):
   - Entra en render.com y crea una cuenta gratis (puedes entrar directamente con tu cuenta de GitHub, así el paso siguiente es más rápido).
   - "New" → "Web Service" → conecta el repositorio `condejorge-wars` que acabas de subir.
   - Render debería detectar automáticamente el archivo `render.yaml` de este proyecto y rellenar solo la configuración (nombre, comando de arranque `node server/index.js`, plan Free). Si no lo detecta solo, configúralo a mano: Runtime "Node", Build Command vacío, Start Command `node server/index.js`, plan **Free**.
   - Te pedirá el valor de la variable de entorno `ADMIN_PASSWORD` (la dejamos fuera del repo a propósito, para que la contraseña de admin no quede pública en GitHub). Pon la que quieras usar.
   - Dale a "Create Web Service". La primera build tarda 1-2 minutos.

3. **Prueba el link**: Render te da una URL del tipo `https://condejorge-wars.onrender.com`. La web pública es esa URL directamente, y el panel de admin es esa misma URL + `/admin` (con la contraseña que pusiste en `ADMIN_PASSWORD`).

4. Repite el mismo flujo de siempre: en `/admin` rellenas facciones y canal de Twitch, "Crear partida", "Iniciar partida", y la gente ya puede escribir `!faccion1` etc. en el chat de Twitch configurado.

Cuando cambiemos código más adelante, solo hace falta volver a subir los archivos actualizados al mismo repositorio de GitHub — Render vuelve a desplegar solo.

## Novedades de interfaz (panel de admin y web pública)

- **Mapa mundial real, estilo Risk**: el mapa es el planeta real (silueta de continentes y océanos, sin la Antártida — esa zona no tiene ciudades ni combate) con un margen arriba y abajo (no llega pegado al borde de la pantalla, como en streamer-wars.com), dividido en tantos territorios irregulares como casillas haya puesto el admin — pero solo la tierra se reparte, el océano se queda como fondo, sin dueño y sin poder conquistarse. Las piezas no respetan fronteras de países reales, son cortes irregulares tipo Risk. Tiene zoom (rueda del ratón o botones **+ / −**) y arrastre para moverte. Se comporta como un mapa de fondo tipo Google Maps: el zoom-out máximo siempre deja el mapa ocupando todo su espacio (nunca más pequeño ni con hueco vacío alrededor) y no se puede arrastrar más allá de sus bordes — como el océano ya ocupa la mayor parte del lienzo, eso da aire de sobra alrededor de la tierra sin verse "ahogado". El zoom máximo es moderado, pensado para ver bien las animaciones de combate, no para acercarse al detalle. La resolución del raster es 5x más fina que la primera versión, para dejar sitio a detalle futuro (ciudades, etc.). Es la misma adyacencia que usa el motor de verdad: si dos territorios de tierra se tocan en el mapa, son vecinos para ataques/expansión. La silueta del planeta sale de datos públicos de costas (dominio público, sin copyright) — sigue siendo un placeholder de color plano, sin arte final — ver `server/worldLandMask.js` (la silueta), `server/mapTemplates.js` (el reparto en territorios) y `public/mapRenderer.js` (el módulo que dibuja el mapa, compartido entre la web pública y el panel de admin, para que ambos lo vean igual).
- **Web pública**: al entrar en la Fase de Resumen se abre automáticamente un popup con lo que pasó esa ronda, separado en Conquistas / Industria / Combates / Bajas. También hay un botón **🏆 Clasificación** arriba que abre un popup con la tabla de facciones (soldados, tanques, territorios, maravillas — reservado para más adelante —, industria de la última ronda, bajas causadas). El roster de jugadores se despliega desde la derecha con el botón **👥 Jugadores**. Al terminar la partida, el mapa y las estadísticas se quedan visibles tal cual (nada se limpia); solo aparece un aviso flotante arriba avisando de que terminó, sin tapar nada, hasta que el admin cree una partida nueva.
- **Panel de admin**: mismo mapa a pantalla completa que la web pública, con un panel lateral (botón **📋 Facciones**) con tarjetas por facción (industria, territorios, bajas causadas, jugadores) y el JSON en crudo plegado por si hace falta para depurar. Al terminar la partida, los botones de "en curso" (pausar/pasar ronda/terminar) se cambian por uno de **🔄 Nueva partida**, que vuelve a mostrar el formulario de configuración para crear otra con los ajustes que quieras — sin tener que reiniciar el servidor ni la página.

## Notas técnicas

- El bot de Twitch y el servidor WebSocket están implementados a mano sobre los módulos nativos de Node (sin `tmi.js` ni `ws`) porque el entorno donde se construyó esta demo tenía bloqueado el registro de npm. Si en tu máquina npm funciona con normalidad, se puede migrar a las librerías estándar sin tocar `server/gameEngine.js` ni `server/rules/*.js` (el motor de reglas no depende de nada de esto).
- La variable de entorno `NODE_USE_ENV_PROXY=1` en el script de arranque solo tiene efecto si tienes configurado un proxy HTTP en tu sistema; si no, no hace nada.
- El estado de la partida vive en memoria: si reinicias el servidor, se pierde la partida en curso (decisión de diseño de la v1, ver `docs/GDD_Condejorge_v1.md`).
- El mapa se genera por partida (silueta real del planeta repartida en `tileCount` territorios de tierra, ver `server/mapTemplates.js`), no es una plantilla con arte real (eso es trabajo futuro).
- La resolución del raster (2200×1151 celdas, recortado para excluir la Antártida) está pensada para que las fronteras se vean nítidas incluso haciendo zoom de cerca a una sola división, y para dejar sitio a detalle futuro (ciudades, etc.); generar el mapa sigue siendo rápido (~130-200ms medido) porque solo se hace una vez por partida, no en cada frame.
- La silueta de continentes/océanos (`server/worldLandMask.js`) sale de datos públicos de costas (Natural Earth, capa "land" a 110m, dominio público — sin copyright ni atribución necesaria) horneados una vez en el propio código como una máscara de bits; no hace falta ninguna librería de imágenes ni conexión a internet para usarla en producción.
