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

- **Mapa estilo Risk**: el mapa es un rectángulo a pantalla completa dividido en tantos territorios irregulares como casillas haya puesto el admin (nada de cuadrícula uniforme) — fronteras dibujadas tipo Voronoi, con zoom (rueda del ratón o botones **+ / −**) y arrastre para moverte. Es la misma adyacencia que usa el motor de verdad: si dos territorios se tocan en el mapa, son vecinos para ataques/expansión. Sigue siendo placeholder de color, sin arte final — ver `server/mapTemplates.js` y `public/mapRenderer.js` (el módulo que dibuja el mapa, compartido entre la web pública y el panel de admin, para que ambos lo vean igual).
- **Web pública**: al entrar en la Fase de Resumen se abre automáticamente un popup con lo que pasó esa ronda, separado en Conquistas / Industria / Combates / Bajas. También hay un botón **🏆 Clasificación** arriba que abre un popup con la tabla de facciones (soldados, tanques, territorios, maravillas — reservado para más adelante —, industria de la última ronda, bajas causadas). El roster de jugadores se despliega desde la derecha con el botón **👥 Jugadores**.
- **Panel de admin**: mismo mapa a pantalla completa que la web pública, con un panel lateral (botón **📋 Facciones**) con tarjetas por facción (industria, territorios, bajas causadas, jugadores) y el JSON en crudo plegado por si hace falta para depurar.

## Notas técnicas

- El bot de Twitch y el servidor WebSocket están implementados a mano sobre los módulos nativos de Node (sin `tmi.js` ni `ws`) porque el entorno donde se construyó esta demo tenía bloqueado el registro de npm. Si en tu máquina npm funciona con normalidad, se puede migrar a las librerías estándar sin tocar `server/gameEngine.js` ni `server/rules/*.js` (el motor de reglas no depende de nada de esto).
- La variable de entorno `NODE_USE_ENV_PROXY=1` en el script de arranque solo tiene efecto si tienes configurado un proxy HTTP en tu sistema; si no, no hace nada.
- El estado de la partida vive en memoria: si reinicias el servidor, se pierde la partida en curso (decisión de diseño de la v1, ver `docs/GDD_Condejorge_v1.md`).
- El mapa se genera por partida (rectángulo raster repartido entre `tileCount` territorios, ver `server/mapTemplates.js`), no es una plantilla con arte real (eso es trabajo futuro).
