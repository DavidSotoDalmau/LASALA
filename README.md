# La sala de las hipótesis

Juego cooperativo asimétrico para 2 a 4 jugadores. Solo HTML, CSS y JavaScript vanilla; la comunicación usa MQTT sobre WebSockets con un broker público. Es un sitio estático: sin backend, base de datos ni compilación.

Cada jugador controla una parte del mecanismo y ve información distinta. Nadie puede resolver una sala solo: hay que describir lo que se ve y traducir entre todos. No hay votaciones; se actúa en tiempo real.

## Archivos

- `index.html`: las cuatro pantallas y la carga de `mqtt.js` (v5.10.1, desde jsDelivr).
- `styles.css`: diseño adaptable desde 360 px, foco visible, `prefers-reduced-motion`.
- `game.js`: protocolo, generadores de salas, lógica de anfitrión e interfaz.
- `README.md`: este documento.

## Ejecutar en local

Sirve la carpeta por HTTP (no abras `index.html` con `file://`):

```bash
python3 -m http.server 8000
# o bien
npx serve .
```

Abre `http://localhost:8000`, crea una partida en una pestaña y únete con el código desde otra pestaña o dispositivo. También funciona en GitHub Pages.

## Cambiar el broker MQTT

Edita `CONFIG` al principio de `game.js`:

```js
const CONFIG = {
  broker: { url: 'wss://broker.emqx.io:8084/mqtt', username: '', password: '' },
  topicPrefix: 'hypothesis/v1'
};
```

La URL debe ser `wss://`. Otras opciones habituales: `wss://broker.hivemq.com:8884/mqtt` o `wss://test.mosquitto.org:8081`; comprueba que sigan activas. La interfaz nunca pide credenciales.

## Las tres salas

Los roles se reparten de forma circular y **rotan en cada sala**, para que todos prueben papeles distintos. Con 2 jugadores, cada uno acumula varios roles.

**1. Los diales.** Cuatro diales de símbolos; cada uno lo controla un jugador y solo su dueño ve el símbolo que muestra. Un jugador tiene el *Manual* (qué color exige cada dial) y otro la *Tabla* (qué símbolo corresponde a cada color). Para saber qué símbolo lleva cada dial hay que combinar ambos. Cualquiera puede *girar la llave*, que dice cuántos diales son correctos y gasta un giro.

**2. El laberinto ciego.** Un jugador mueve la ficha sin ver el mapa y solo sabe si avanzó o chocó. Otro ve el mapa (con colores en cada casilla, inicio y salida) pero no la ficha. El *Sensor de suelo* dice el color de la casilla actual y el *Radio de fila* dice la fila. Cada choque cuenta.

**3. El cifrado.** Una palabra de 5 letras se cifra desplazando las letras hacia delante. Un jugador ve el *mensaje cifrado*, otro tiene el *símbolo clave*, otro la *rueda* que convierte cada símbolo en un número de desplazamiento y otro la *categoría* de la palabra. Cualquiera envía la respuesta; las erróneas dicen cuántas letras están en su sitio y gastan un intento.

| Dificultad | Giros de llave | Choques | Respuestas erróneas | Laberinto |
|---|---|---|---|---|
| Fácil | 8 | 14 | 5 | 4×4 |
| Normal | 6 | 10 | 4 | 5×5 |
| Difícil | 5 | 7 | 3 | 6×6 |

Se gana al resolver las tres salas en 8 minutos. Se pierde al agotar el tiempo o los intentos de una sala.

## Protocolo

Tópicos: `hypothesis/v1/rooms/{ROOM}/events` (común) y `hypothesis/v1/rooms/{ROOM}/private/{CLIENT_ID}` (privado). Los mensajes son JSON con `protocolVersion`, `roomCode`, `type`, `senderId`, `messageId`, `timestamp` y `payload`. Se descartan los de otra versión o sala, de más de 2 KB, de tipo desconocido, con `messageId` repetido o con campos o tipos inesperados.

Tipos: `PLAYER_JOIN`, `PLAYER_LEAVE`, `HOST_CHANGED`, `GAME_START`, `PRIVATE_VIEW`, `ROOM_START`, `ACTION`, `ROOM_UPDATE`, `ROOM_SOLVED`, `GAME_OVER`, `CHAT_MESSAGE`, `HEARTBEAT`, `STATE_SYNC_REQUEST`, `STATE_SYNC`.

- El anfitrión genera cada sala y guarda las soluciones solo en su memoria. Los datos privados de cada rol viajan en `PRIVATE_VIEW` por el tópico privado del jugador.
- Los jugadores envían `ACTION` (girar un dial, girar la llave, mover, responder); el anfitrión valida quién puede hacer qué y publica `ROOM_UPDATE`.
- La posición de la ficha y las soluciones nunca se publican en el tópico común.
- QoS 0 para chat y heartbeats; QoS 1 para el resto. Sin mensajes retenidos.
- Heartbeat cada 5 s; desconectado tras 15 s; identidad recuperable 60 s con el mismo `CLIENT_ID` (guardado en `sessionStorage`, por pestaña).
- Límites locales: 5 mensajes de chat por 10 s y 12 acciones por 5 s.

## Limitaciones

- Los brokers públicos pueden cambiar, limitar conexiones o perder mensajes.
- Cualquiera con el código y el prefijo de tópicos puede leer los mensajes. La privacidad es una mecánica de juego, no seguridad. Los símbolos de los diales también viajan por el tópico común y la interfaz solo los muestra a su dueño.
- El anfitrión es un navegador. Si se desconecta durante la partida, la nueva persona anfitriona no puede recuperar las soluciones y la partida termina con "El anfitrión se desconectó; esta partida no se puede recuperar". Es adecuado para juego casual, no para competición.
- Las pestañas en segundo plano pueden ralentizar sus temporizadores y parecer desconectadas.

## Decisiones técnicas

1. Los roles se calculan igual en todos los clientes a partir del orden de jugadores al empezar la sala (`order`), de modo que todos saben quién tiene qué rol (no su contenido).
2. Si un jugador con rol es retirado (60 s sin conexión o sale), otro jugador conectado hereda sus roles y el anfitrión le reenvía la información.
3. La partida se pausa con menos de 2 jugadores conectados; el temporizador no se reinicia al reconectar.
4. Nuevos jugadores solo pueden unirse en la sala de espera.
5. Se asume que el broker devuelve a cada cliente sus propios mensajes; todos procesan los eventos en el mismo orden.
