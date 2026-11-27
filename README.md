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

**1. Los diales.** Diales de símbolos (4 en Fácil, 7 en Normal, 10 en Difícil; el color que exige cada uno puede repetirse); cada uno lo controla un jugador y solo su dueño ve el símbolo que muestra. Un jugador tiene el *Manual* (qué color exige cada dial) y otro la *Tabla* (qué símbolo corresponde a cada color). Para saber qué símbolo lleva cada dial hay que combinar ambos. Cualquiera puede *girar la llave*, que dice cuántos diales son correctos y gasta un giro.

**2. El laberinto ciego.** Un jugador mueve la ficha sin ver el mapa y solo sabe si avanzó o chocó. Otro ve el mapa (con colores en cada casilla, inicio y salida) pero no la ficha. El *Sensor de suelo* dice el color de la casilla actual y el *Radio de fila* dice la fila. Cada choque cuenta. En Normal y Difícil la ficha empieza en una casilla al azar y el mapa no marca el inicio: hay que deducirlo con el color del suelo, la fila y los resultados de los movimientos. En Fácil el inicio sí está marcado.

**3. El cifrado.** Una palabra (5, 7 o 10 letras según la dificultad) se cifra desplazando las letras hacia delante. Un jugador ve el *mensaje cifrado*, otro tiene el *símbolo clave*, otro la *rueda* que convierte cada símbolo en un número de desplazamiento y otro la *categoría* de la palabra. Cualquiera envía la respuesta; las erróneas dicen cuántas letras están en su sitio y gastan un intento.

| Dificultad | Giros de llave | Choques | Respuestas erróneas | Laberinto | Extras |
|---|---|---|---|---|---|
| Fácil | 8 | 14 | 5 | 4×4, inicio marcado, 4 colores | 4 diales, palabra de 5 letras, se indica cuántos aciertos hay |
| Normal | 6 | 10 | 4 | 5×5, inicio oculto, 4 colores | 7 diales (2 invertidos), palabra de 7 letras posiblemente al revés, sin recuento de aciertos, −15 s por error |
| Difícil | 5 | 7 | 3 | 6×6, inicio oculto, 3 colores | 10 diales (3 invertidos), palabra de 10 letras posiblemente al revés, sin recuento de aciertos, −15 s por error |

En Normal y Difícil aparecen dos roles más: el *Interruptor de inversión* (diales cuyo símbolo correcto es el opuesto en el círculo de símbolos) y el *Sentido de lectura* (si la palabra descifrada hay que leerla al revés). Un error es un giro fallido, un choque o una respuesta incorrecta.

### Complicaciones adicionales

| Complicación | Normal | Difícil |
|---|---|---|
| Deriva de los diales: todos avanzan un símbolo por su cuenta | cada 60 s | cada 45 s |
| Sensor de suelo con ruido: a veces da un color falso | 20 % | 30 % |
| Información privada efímera: se ve 15 s y no se puede volver a ver hasta pasados 30 s | no | sí |
| Chat sin nombres de símbolos ni de colores (hay que describirlos) | no | sí |
| Rueda que se baraja: cada respuesta errónea cambia clave y mensaje | no | sí |
| Saboteador: un jugador recibe un dato falso en cada sala y no lo sabe (3 o 4 jugadores) | no | sí |

El saboteador se elige al azar en cada sala entre quienes tienen información corruptible. Con 2 jugadores se desactiva, porque nadie podría contrastar el dato. El anfitrión puede ser saboteador: su cliente recibe el dato falso como cualquier otro, y la verdad solo está en la memoria del anfitrión. El filtro de palabras del chat se aplica en el cliente (juego casual, no a prueba de trampas).

### Microjuegos para desbloquear las pistas

Cada pista privada (cada tarjeta amarilla con datos) empieza **bloqueada**. Para verla hay que superar un microjuego, que se asigna **al azar y por separado a cada pista**: *Memoria de flechas*, *Reflejos*, *Cálculo rápido* o *Cerradura de precisión*. Se juegan solo en tu navegador (no viajan por la red) y el tiempo de la partida no se detiene mientras juegas. Si fallas, se reinicia el microjuego.

| | Fácil | Normal | Difícil |
|---|---|---|---|
| Memoria: pasos de la secuencia | 3 | 5 | 7 |
| Reflejos: aciertos seguidos / ancho de la zona / velocidad | 1 / 30 % / lenta | 2 / 20 % / media | 3 / 12 % / rápida |
| Cálculo: operaciones / tiempo | 3 sumas / 45 s | 4 mixtas / 35 s | 5 con multiplicación / 30 s |
| Cerradura: ajustes seguidos / margen | 1 / ±6 | 2 / ±3 | 3 / ±1 |

Son accesibles con teclado y no dependen del color. Con «reducir movimiento» activado en el sistema, el marcador de Reflejos va más despacio. En Difícil, la ocultación de la información privada (15 s visible) solo empieza a contar cuando ya has desbloqueado todas tus pistas, y vuelve a empezar cada vez que desbloqueas una. Los desbloqueos se pierden si recargas la página.

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
