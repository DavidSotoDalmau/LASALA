'use strict';
/* =====================================================================
   La sala de las hipótesis — juego cooperativo asimétrico (HTML + JS vanilla + MQTT/WebSockets)
   Tres salas: Los diales, El laberinto ciego, El cifrado.
   Cada jugador controla una parte del mecanismo y ve información distinta. Sin votaciones.
   Secciones:
    1. Configuración y constantes        6. Estado
    2. Utilidades                        7. Manejadores de mensajes
    3. Salas: generadores y roles        8. Lógica de anfitrión
    4. Validación de mensajes            9. Presencia, heartbeats, temporizador
    5. Conexión MQTT y envío            10. Interfaz   11. Acciones y arranque
   ===================================================================== */
(function () {

/* ===================== 1. CONFIGURACIÓN Y CONSTANTES ===================== */

// Cambia aquí el broker. Debe aceptar MQTT sobre WebSockets seguros (wss://).
const CONFIG = {
  broker: { url: 'wss://broker.emqx.io:8084/mqtt', username: '', password: '' },
  topicPrefix: 'hypothesis/v1'
};

const PROTOCOL_VERSION = 1;
const MAX_MSG_BYTES = 2048;
const HEARTBEAT_MS = 5000;
const OFFLINE_MS = 15000;
const REJOIN_MS = 60000;
const GAME_MS = 8 * 60 * 1000;
const TOTAL_ROOMS = 3;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const NEXT_ROOM_DELAY_MS = 2500;
const CHAT_LIMIT = { count: 5, windowMs: 10000 };
const ACTION_LIMIT = { count: 12, windowMs: 5000 };
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const SESSION_KEY = 'hypothesis-session-v2';

// keys: giros de llave (sala 1). bumps: choques permitidos (sala 2). tries: respuestas erróneas (sala 3).
const DIFFICULTIES = {
  easy:   { label: 'Fácil',   keys: 8, bumps: 14, tries: 5, maze: 4, hideStart: false, colors: 4, invert: 0, reverse: false, showCount: true,  penaltyMs: 0 },
  normal: { label: 'Normal',  keys: 6, bumps: 10, tries: 4, maze: 5, hideStart: true,  colors: 4, invert: 1, reverse: true,  showCount: false, penaltyMs: 15000 },
  hard:   { label: 'Difícil', keys: 5, bumps: 7,  tries: 3, maze: 6, hideStart: true,  colors: 3, invert: 2, reverse: true,  showCount: false, penaltyMs: 15000 }
};

const SYMBOLS = [
  { id: 'sun',  name: 'Sol',      glyph: '\u2600\uFE0E' },
  { id: 'moon', name: 'Luna',     glyph: '\u263E' },
  { id: 'star', name: 'Estrella', glyph: '\u2605\uFE0E' },
  { id: 'key',  name: 'Llave',    glyph: '\u26BF' },
  { id: 'drop', name: 'Gota',     glyph: '\u25C6' },
  { id: 'leaf', name: 'Hoja',     glyph: '\u2667' }
];
const symById = id => SYMBOLS.find(s => s.id === id);
const symLabel = id => { const s = symById(id); return s ? s.name + ' ' + s.glyph : '?'; };

const COLORS = [
  { id: 'rojo',    name: 'Rojo',    code: 'Roj', hex: '#c62828' },
  { id: 'azul',    name: 'Azul',    code: 'Azu', hex: '#1565c0' },
  { id: 'verde',   name: 'Verde',   code: 'Ver', hex: '#2e7d32' },
  { id: 'ambar',   name: 'Ámbar',   code: 'Amb', hex: '#f9a825' },
  { id: 'violeta', name: 'Violeta', code: 'Vio', hex: '#6a1b9a' },
  { id: 'gris',    name: 'Gris',    code: 'Gri', hex: '#455a64' }
];
const colorById = id => COLORS.find(c => c.id === id);

const ROOM_TYPES = ['dials', 'maze', 'cipher'];
const ROOM_TITLES = { dials: 'Los diales', maze: 'El laberinto ciego', cipher: 'El cifrado' };
const ROOM_INTROS = {
  dials: 'Cada dial lo controla un jugador, y solo su dueño ve el símbolo que muestra. Descubrid qué símbolo debe llevar cada dial y luego girad la llave.',
  maze: 'Una persona mueve la ficha sin ver el mapa; otra ve el mapa pero no la ficha. Guiaos con el color del suelo y la fila para encontrar la salida. Cada choque contra un muro cuenta. En Normal y Difícil el mapa no marca el inicio: hay que deducirlo.',
  cipher: 'El mensaje cifrado desplaza cada letra hacia delante en el alfabeto de 26 letras (A–Z, sin Ñ). Hay que averiguar cuántos puestos y retroceder. Enviad la palabra de 5 letras.'
};
const COUNTER_LABELS = { dials: 'Giros de llave', maze: 'Choques', cipher: 'Respuestas erróneas' };
const ROLE_LISTS = {
  dials: ['manual', 'tabla'],
  maze: ['mapa', 'mover', 'suelo', 'fila'],
  cipher: ['texto', 'clave', 'tabla', 'categoria']
};
const ROLE_NAMES = {
  dials: { manual: 'Manual de la cerradura', tabla: 'Tabla de colores', regla: 'Interruptor de inversión' },
  maze: { mapa: 'Mapa del laberinto', mover: 'Mover la ficha', suelo: 'Sensor de suelo', fila: 'Radio de fila' },
  cipher: { texto: 'Mensaje cifrado', clave: 'Símbolo clave', tabla: 'Rueda de desplazamientos', categoria: 'Categoría', orden: 'Sentido de lectura' }
};
const ALL_ROLES = ['manual', 'tabla', 'regla', 'mapa', 'mover', 'suelo', 'fila', 'texto', 'clave', 'categoria', 'orden'];
const DIRS = [
  { name: 'Norte', cls: 'n', dr: -1, dc: 0, bit: 1 },
  { name: 'Este',  cls: 'e', dr: 0,  dc: 1, bit: 2 },
  { name: 'Sur',   cls: 's', dr: 1,  dc: 0, bit: 4 },
  { name: 'Oeste', cls: 'o', dr: 0,  dc: -1, bit: 8 }
];
const WORDS = [
  ['TIGRE', 'Animal'], ['ZORRO', 'Animal'], ['CABRA', 'Animal'], ['LLAMA', 'Animal'], ['COBRA', 'Animal'],
  ['ROBLE', 'Árbol'], ['PALMA', 'Árbol'], ['CEDRO', 'Árbol'], ['OLIVO', 'Árbol'], ['ROSAL', 'Árbol'],
  ['QUESO', 'Comida'], ['PASTA', 'Comida'], ['TARTA', 'Comida'], ['MANGO', 'Comida'], ['SALSA', 'Comida']
];

/* ===================== 2. UTILIDADES ===================== */

function randInt(n) {
  const a = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  let x;
  do { crypto.getRandomValues(a); x = a[0]; } while (x >= limit);
  return x % n;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function randomString(alphabet, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[randInt(alphabet.length)];
  return s;
}
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newClientId = () => 'p' + randomString(ALNUM, 11);
const newMessageId = () => randomString(ALNUM, 16);
const newRoomCode = () => randomString(ROOM_ALPHABET, 6);
const byteLength = s => new TextEncoder().encode(s).length;
const bySeq = (a, b) => a.seq - b.seq;

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

/* ============ 3. SALAS: ROLES Y GENERADORES (solo los usa el anfitrión) ============ */

// Reparto de roles determinista: lo calculan igual el anfitrión y los clientes a partir de `order`.
// Lista de roles de cada sala según la dificultad (Normal y Difícil añaden roles).
function roleList(type) {
  const d = DIFFICULTIES[G.difficulty] || DIFFICULTIES.normal;
  if (type === 'dials') return d.invert ? ROLE_LISTS.dials.concat('regla') : ROLE_LISTS.dials;
  if (type === 'cipher') return d.reverse ? ROLE_LISTS.cipher.concat('orden') : ROLE_LISTS.cipher;
  return ROLE_LISTS[type];
}
function roleHolder(type, role, order, room) {
  const k = roleList(type).indexOf(role);
  return order[(room + k) % order.length];
}
function dialOwner(i, order, room) { return order[(i + room) % order.length]; }
function rolesOf(type, order, room, id) {
  return roleList(type).filter(r => roleHolder(type, r, order, room) === id);
}

// Sala 1: manual (dial -> color) + tabla (color -> símbolo) => símbolo correcto de cada dial.
function genDials(cfg) {
  const tableSyms = shuffle([0, 1, 2, 3, 4, 5]);               // color i -> símbolo tableSyms[i]
  const dialColors = shuffle([0, 1, 2, 3, 4, 5]).slice(0, 4);  // color que exige cada dial
  const inverted = shuffle([0, 1, 2, 3]).slice(0, cfg.invert).sort();  // diales invertidos: símbolo opuesto (+3 en el círculo)
  const solution = dialColors.map((c, i) => inverted.includes(i) ? (tableSyms[c] + 3) % 6 : tableSyms[c]);
  let dials;
  do { dials = solution.map(() => randInt(6)); } while (dials.some((v, i) => v === solution[i]));
  return {
    solution, dials,
    views: {
      manual: dialColors.map(c => COLORS[c].id),
      tabla: COLORS.flatMap((c, i) => [c.id, SYMBOLS[tableSyms[i]].id]),
      regla: inverted.map(i => String(i + 1))
    }
  };
}

// Sala 2: laberinto perfecto n×n (DFS). Muros por bits: N=1, E=2, S=4, O=8.
function genMaze(n, randomStart, ncolors) {
  const walls = new Array(n * n).fill(15);
  const seen = new Array(n * n).fill(false);
  const carve = [[-1, 0, 1, 4], [0, 1, 2, 8], [1, 0, 4, 1], [0, -1, 8, 2]];
  const stack = [0]; seen[0] = true;
  while (stack.length) {
    const cur = stack[stack.length - 1], r = Math.floor(cur / n), c = cur % n;
    const opts = carve.filter(([dr, dc]) => {
      const rr = r + dr, cc = c + dc;
      return rr >= 0 && rr < n && cc >= 0 && cc < n && !seen[rr * n + cc];
    });
    if (!opts.length) { stack.pop(); continue; }
    const [dr, dc, b1, b2] = opts[randInt(opts.length)];
    const nx = (r + dr) * n + (c + dc);
    walls[cur] &= ~b1; walls[nx] &= ~b2; seen[nx] = true; stack.push(nx);
  }
  // Salida: la casilla más lejana desde el inicio (BFS).
  const start = randomStart ? randInt(n * n) : 0;
  const dist = new Array(n * n).fill(-1); dist[start] = 0;
  const queue = [start]; let far = start;
  while (queue.length) {
    const cur = queue.shift(), r = Math.floor(cur / n), c = cur % n;
    DIRS.forEach(d => {
      if (walls[cur] & d.bit) return;
      const nx = (r + d.dr) * n + (c + d.dc);
      if (dist[nx] === -1) { dist[nx] = dist[cur] + 1; queue.push(nx); if (dist[nx] > dist[far]) far = nx; }
    });
  }
  const colors = walls.map(() => randInt(ncolors || 4));
  return { n, walls, colors, pos: start, exit: far };
}
function mazeViews(m, hideStart) {
  const sr = hideStart ? -1 : Math.floor(m.pos / m.n), sc = hideStart ? -1 : m.pos % m.n;
  const mapData = [String(m.n), String(m.n), String(sr), String(sc), String(Math.floor(m.exit / m.n)), String(m.exit % m.n)];
  m.walls.forEach((w, i) => mapData.push(w + ':' + m.colors[i]));
  return {
    mapa: mapData, mover: [],
    suelo: [COLORS[m.colors[m.pos]].id],
    fila: [String(Math.floor(m.pos / m.n) + 1)]
  };
}

// Sala 3: César con desplazamiento dado por un símbolo clave; rueda símbolo -> número.
function genCipher(cfg) {
  const [word, cat] = WORDS[randInt(WORDS.length)];
  const shifts = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, 6);
  const keyIdx = randInt(6);
  const shift = shifts[keyIdx];
  const rev = cfg.reverse && randInt(2) === 1;
  const base = rev ? word.split('').reverse().join('') : word;
  const enc = base.split('').map(ch => String.fromCharCode(65 + (ch.charCodeAt(0) - 65 + shift) % 26)).join('');
  return {
    word,
    views: {
      texto: [enc], clave: [SYMBOLS[keyIdx].id], categoria: [cat], orden: [rev ? 'alreves' : 'derecho'],
      tabla: SYMBOLS.flatMap((s, i) => [s.id, String(shifts[i])])
    }
  };
}

/* ===================== 4. VALIDACIÓN DE MENSAJES ===================== */

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysAre = (o, keys) => isPlain(o) && Object.keys(o).length === keys.length &&
  keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isBool = v => typeof v === 'boolean';
const isId = v => typeof v === 'string' && ID_RE.test(v);
const isName = v => isStr(v, 1, 16);
const isDiff = v => typeof v === 'string' && Object.prototype.hasOwnProperty.call(DIFFICULTIES, v);
const isOrder = v => Array.isArray(v) && v.length >= 1 && v.length <= MAX_PLAYERS && v.every(isId);
const isDials = v => Array.isArray(v) && v.length === 4 && v.every(x => isInt(x, 0, 5));
const isPlayerEntry = p => keysAre(p, ['id', 'name', 'seq', 'connected']) && isId(p.id) && isName(p.name) && isInt(p.seq, 1, 9999) && isBool(p.connected);
const UPDATE_EVENTS = ['dial', 'key', 'move_ok', 'bump', 'answer_wrong'];

// qos: 0 para chat y presencia; 1 para cambios de estado y acciones.
const TYPES = {
  PLAYER_JOIN: { qos: 1, validate: p => keysAre(p, ['name', 'reconnect']) && isName(p.name) && isBool(p.reconnect) },
  PLAYER_LEAVE: { qos: 1, validate: p => keysAre(p, ['playerId', 'reason']) && isId(p.playerId) && (p.reason === 'left' || p.reason === 'timeout') },
  HOST_CHANGED: { qos: 1, validate: p => keysAre(p, ['newHostId', 'oldHostId']) && isId(p.newHostId) && isId(p.oldHostId) },
  GAME_START: { qos: 1, validate: p => keysAre(p, ['difficulty', 'totalRooms', 'remainingMs']) && isDiff(p.difficulty) && p.totalRooms === TOTAL_ROOMS && isInt(p.remainingMs, 0, GAME_MS) },
  PRIVATE_VIEW: { qos: 1, validate: p => keysAre(p, ['room', 'role', 'data']) && isInt(p.room, 0, TOTAL_ROOMS - 1) && ALL_ROLES.includes(p.role) &&
    Array.isArray(p.data) && p.data.length <= 64 && p.data.every(x => isStr(x, 0, 12)) },
  ROOM_START: { qos: 1, validate: p => keysAre(p, ['room', 'max', 'order', 'remainingMs', 'dials']) && isInt(p.room, 0, TOTAL_ROOMS - 1) && isInt(p.max, 1, 30) && isOrder(p.order) && isInt(p.remainingMs, 0, GAME_MS) && isDials(p.dials) },
  ACTION: { qos: 1, validate: p => keysAre(p, ['kind', 'a', 'b', 'text']) && ['dial', 'key', 'move', 'answer'].includes(p.kind) && isInt(p.a, -1, 9) && isInt(p.b, -1, 9) && isStr(p.text, 0, 5) && /^[A-Z]*$/.test(p.text) },
  ROOM_UPDATE: { qos: 1, validate: p => keysAre(p, ['room', 'event', 'by', 'a', 'b', 'used', 'max', 'remainingMs']) && isInt(p.remainingMs, 0, GAME_MS) && isInt(p.room, 0, TOTAL_ROOMS - 1) && UPDATE_EVENTS.includes(p.event) && isId(p.by) && isInt(p.a, -1, 99) && isInt(p.b, -1, 99) && isInt(p.used, 0, 99) && isInt(p.max, 1, 30) },
  ROOM_SOLVED: { qos: 1, validate: p => keysAre(p, ['room', 'roomsSolved', 'remainingMs']) && isInt(p.room, 0, TOTAL_ROOMS - 1) && isInt(p.roomsSolved, 1, TOTAL_ROOMS) && isInt(p.remainingMs, 0, GAME_MS) },
  GAME_OVER: { qos: 1, validate: p => keysAre(p, ['won', 'reason', 'roomsSolved', 'remainingMs']) && isBool(p.won) && ['solved', 'time', 'attempts', 'host_lost'].includes(p.reason) && isInt(p.roomsSolved, 0, TOTAL_ROOMS) && isInt(p.remainingMs, 0, GAME_MS) },
  CHAT_MESSAGE: { qos: 0, validate: p => keysAre(p, ['text']) && isStr(p.text, 1, 200) },
  HEARTBEAT: { qos: 0, validate: p => keysAre(p, ['name', 'phase', 'roomIndex', 'remainingMs', 'isHost']) && isName(p.name) && ['lobby', 'playing', 'over'].includes(p.phase) && isInt(p.roomIndex, 0, TOTAL_ROOMS - 1) && (p.remainingMs === null || isInt(p.remainingMs, 0, GAME_MS)) && isBool(p.isHost) },
  STATE_SYNC_REQUEST: { qos: 1, validate: p => keysAre(p, []) },
  STATE_SYNC: { qos: 1, validate: p => keysAre(p, ['rejected', 'hostId', 'phase', 'difficulty', 'roomIndex', 'remainingMs', 'roomsSolved', 'used', 'max', 'order', 'dials', 'players']) &&
    (p.rejected === null || ['full', 'started', 'unknown', 'over'].includes(p.rejected)) &&
    isId(p.hostId) && ['lobby', 'playing', 'over'].includes(p.phase) && isDiff(p.difficulty) &&
    isInt(p.roomIndex, 0, TOTAL_ROOMS - 1) && isInt(p.remainingMs, 0, GAME_MS) && isInt(p.roomsSolved, 0, TOTAL_ROOMS) &&
    isInt(p.used, 0, 99) && isInt(p.max, 1, 30) && Array.isArray(p.order) && p.order.length <= MAX_PLAYERS && p.order.every(isId) && isDials(p.dials) &&
    Array.isArray(p.players) && p.players.length >= 1 && p.players.length <= MAX_PLAYERS && p.players.every(isPlayerEntry) }
};
const PRIVATE_TYPES = ['PRIVATE_VIEW', 'STATE_SYNC'];
const HOST_ONLY = new Set(['GAME_START', 'PRIVATE_VIEW', 'ROOM_START', 'ROOM_UPDATE', 'ROOM_SOLVED', 'GAME_OVER']);

function validateEnvelope(m, isPrivate) {
  if (!keysAre(m, ['protocolVersion', 'roomCode', 'type', 'senderId', 'messageId', 'timestamp', 'payload'])) return false;
  if (m.protocolVersion !== PROTOCOL_VERSION) return false;
  if (m.roomCode !== net.roomCode) return false;
  if (typeof m.type !== 'string' || !Object.prototype.hasOwnProperty.call(TYPES, m.type)) return false;
  if (!isId(m.senderId) || !isStr(m.messageId, 8, 40)) return false;
  if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp)) return false;
  if (isPrivate && !PRIVATE_TYPES.includes(m.type)) return false;
  if (!isPrivate && m.type === 'PRIVATE_VIEW') return false;
  return TYPES[m.type].validate(m.payload);
}

const recentIds = new Map();
function isDuplicate(id) {
  if (recentIds.has(id)) return true;
  recentIds.set(id, Date.now());
  return false;
}
function pruneRecentIds() {
  const now = Date.now();
  for (const [id, t] of recentIds) if (now - t > 120000) recentIds.delete(id);
  while (recentIds.size > 2000) recentIds.delete(recentIds.keys().next().value);
}

/* ===================== 5. CONEXIÓN MQTT Y ENVÍO ===================== */

const net = { client: null, online: false, clientId: '', roomCode: '', evtTopic: '', privTopic: '' };
const topicEvents = room => CONFIG.topicPrefix + '/rooms/' + room + '/events';
const topicPrivate = (room, id) => CONFIG.topicPrefix + '/rooms/' + room + '/private/' + id;

function setRoom(code) {
  net.roomCode = code;
  net.evtTopic = topicEvents(code);
  net.privTopic = topicPrivate(code, net.clientId);
}

function connectBroker() {
  return new Promise((resolve, reject) => {
    if (typeof window.mqtt === 'undefined') { reject(new Error('no se cargó la biblioteca MQTT desde el CDN')); return; }
    const opts = { clientId: net.clientId, clean: true, reconnectPeriod: 2000, connectTimeout: 8000, keepalive: 30 };
    if (CONFIG.broker.username) opts.username = CONFIG.broker.username;
    if (CONFIG.broker.password) opts.password = CONFIG.broker.password;
    let settled = false, firstConnect = true;
    const client = window.mqtt.connect(CONFIG.broker.url, opts);
    net.client = client;
    const fail = err => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { client.end(true); } catch (e) { /* nada */ }
      net.client = null; net.online = false;
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('tiempo de espera agotado')), 10000);
    client.on('connect', () => {
      net.online = true;
      client.subscribe([net.evtTopic, net.privTopic], { qos: 1 }, (err, granted) => {
        if (err || !granted || granted.some(g => g.qos === 128)) {
          if (firstConnect) fail(new Error('el broker rechazó la suscripción'));
          return;
        }
        if (firstConnect) { firstConnect = false; settled = true; clearTimeout(timer); resolve(); }
        else onBrokerReconnected();
        updateConnBanner();
      });
    });
    client.on('message', (topic, payload) => {
      const len = payload.byteLength !== undefined ? payload.byteLength : payload.length;
      onRawMessage(topic, payload.toString(), len);
    });
    client.on('error', err => { if (!settled) fail(err); else console.warn('MQTT error:', err && err.message); });
    const down = () => { net.online = false; updateConnBanner(); };
    client.on('close', down); client.on('offline', down); client.on('reconnect', down);
  });
}

function disconnectBroker() {
  const c = net.client;
  net.client = null; net.online = false;
  if (c) { try { c.end(true); } catch (e) { /* nada */ } }
}

function send(type, payload, opts) {
  if (!net.client || !net.online) return false;
  const msg = { protocolVersion: PROTOCOL_VERSION, roomCode: net.roomCode, type, senderId: net.clientId,
    messageId: newMessageId(), timestamp: Date.now(), payload };
  const text = JSON.stringify(msg);
  if (byteLength(text) > MAX_MSG_BYTES) { console.error('Mensaje demasiado grande:', type); return false; }
  net.client.publish((opts && opts.topic) || net.evtTopic, text, { qos: TYPES[type].qos, retain: false },
    err => { if (err) console.warn('Publicación fallida', type, err.message); });
  return true;
}

function onRawMessage(topic, raw, len) {
  const isPrivate = topic === net.privTopic;
  if (!isPrivate && topic !== net.evtTopic) return;
  if (len > MAX_MSG_BYTES) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!validateEnvelope(msg, isPrivate)) return;
  if (isDuplicate(msg.messageId)) return;
  dispatch(msg);
}

/* ===================== 6. ESTADO ===================== */

const me = { id: '', name: '' };

function freshGame() {
  return {
    joined: false, hostId: null, phase: 'lobby', difficulty: 'normal',
    players: [],  // {id,name,seq,connected,lastSeen,disconnectedAt,expiring}
    roomIndex: 0, remainingMs: GAME_MS, roomsSolved: 0,
    order: [], dials: [0, 0, 0, 0], used: 0, max: 6, last: null,
    views: {},    // "sala:rol" -> datos privados (solo los míos)
    log: [], chat: [], result: null, roomTransition: false, awaitRecoverySince: null
  };
}
let G = freshGame();
let H = null; // estado autoritativo del anfitrión (solo en su memoria)

const ui = { screen: 'home', busy: false, hideClues: false, chatRendered: 0, joinTimer: null, renderQueued: false };
const rate = { chat: [], actions: [] };

const getPlayer = id => G.players.find(p => p.id === id) || null;
const connectedPlayers = () => G.players.filter(p => p.connected).sort(bySeq);
const amHost = () => G.joined && G.hostId === me.id;
const isPaused = () => G.phase === 'playing' && (connectedPlayers().length < MIN_PLAYERS || G.awaitRecoverySince !== null);
const nameOf = id => { const p = getPlayer(id); return p ? p.name : 'Jugador'; };
const makePlayer = (id, name, seq) => ({ id, name, seq, connected: true, lastSeen: Date.now(), disconnectedAt: null, expiring: false });
const roomType = () => ROOM_TYPES[G.roomIndex];
const myRoles = () => (G.phase === 'playing' && G.order.length) ? rolesOf(roomType(), G.order, G.roomIndex, me.id) : [];

function resetAll() {
  if (H) { clearTimeout(H.transitionTimer); }
  clearTimeout(ui.joinTimer);
  G = freshGame(); H = null;
  ui.chatRendered = 0; ui.hideClues = false;
  rate.chat = []; rate.actions = [];
  recentIds.clear();
}

function saveSession() {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ clientId: me.id, roomCode: net.roomCode, name: me.name })); } catch (e) { /* nada */ }
}
function loadSession() {
  try { const s = JSON.parse(sessionStorage.getItem(SESSION_KEY)); return isPlain(s) ? s : null; } catch (e) { return null; }
}
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* nada */ } }

/* ===================== 7. MANEJADORES DE MENSAJES ===================== */

function dispatch(msg) {
  const t = msg.type, p = msg.payload, s = msg.senderId;
  if (!G.joined) { if (t === 'STATE_SYNC' && p.hostId === s) applySync(msg); return; }
  if (t === 'STATE_SYNC') { if (p.hostId === s && (s === G.hostId || getPlayer(s))) applySync(msg); return; }
  if (HOST_ONLY.has(t) && s !== G.hostId) return;
  touch(s);
  handlers[t](msg);
  scheduleRender();
}

function touch(id) {
  const p = getPlayer(id);
  if (!p || id === me.id) return;
  p.lastSeen = Date.now();
  if (!p.connected) { p.connected = true; p.disconnectedAt = null; p.expiring = false; }
}

function addLog(text) { G.log.push(text); if (G.log.length > 8) G.log.shift(); }

const handlers = {
  PLAYER_JOIN(msg) {
    if (!amHost()) return;
    const id = msg.senderId, existing = getPlayer(id);
    if (existing) {
      existing.connected = true; existing.lastSeen = Date.now(); existing.disconnectedAt = null; existing.expiring = false;
      hostBroadcastSync(); hostSendViews(id);
      return;
    }
    if (G.phase === 'over') { hostSendRejected(id, 'over'); return; }
    if (G.phase !== 'lobby') { hostSendRejected(id, 'started'); return; }
    if (G.players.length >= MAX_PLAYERS) { hostSendRejected(id, 'full'); return; }
    const seq = G.players.reduce((m, p) => Math.max(m, p.seq), 0) + 1;
    G.players.push(makePlayer(id, msg.payload.name, seq));
    hostBroadcastSync();
    toast(msg.payload.name + ' se ha unido.', '');
  },

  PLAYER_LEAVE(msg) {
    const p = msg.payload;
    if (p.reason === 'left' && msg.senderId !== p.playerId) return;
    if (p.reason === 'timeout' && msg.senderId !== G.hostId) return;
    if (p.playerId === me.id) { if (p.reason === 'timeout') handleRemoved('unknown'); return; }
    removePlayer(p.playerId, p.reason);
  },

  HOST_CHANGED(msg) {
    const p = msg.payload;
    if (msg.senderId !== p.newHostId || msg.senderId === me.id || !getPlayer(p.newHostId)) return;
    G.hostId = p.newHostId;
    if (G.phase === 'playing' && G.awaitRecoverySince === null) G.awaitRecoverySince = performance.now();
    toast(nameOf(p.newHostId) + ' es ahora el anfitrión.', '');
  },

  GAME_START(msg) {
    const p = msg.payload;
    if (G.phase !== 'lobby') return;
    G.phase = 'playing'; G.difficulty = p.difficulty; G.remainingMs = p.remainingMs;
    G.roomsSolved = 0; G.roomIndex = 0; G.roomTransition = false; G.log = [];
    setScreen('game');
  },

  PRIVATE_VIEW(msg) { G.views[msg.payload.room + ':' + msg.payload.role] = msg.payload.data; },

  ROOM_START(msg) {
    const p = msg.payload;
    if (G.phase !== 'playing') return;
    G.roomIndex = p.room; G.max = p.max; G.order = p.order; G.dials = p.dials; G.used = 0; G.last = null;
    G.remainingMs = p.remainingMs; G.roomTransition = false; G.log = [];
    addLog('Empieza la sala «' + ROOM_TITLES[ROOM_TYPES[p.room]] + '».');
    toast('Sala ' + (p.room + 1) + ' de ' + TOTAL_ROOMS + ': ' + ROOM_TITLES[ROOM_TYPES[p.room]], 'good');
  },

  ACTION(msg) { if (amHost()) hostOnAction(msg); },

  ROOM_UPDATE(msg) {
    const p = msg.payload;
    if (p.room !== G.roomIndex) return;
    G.used = p.used; G.max = p.max; G.remainingMs = p.remainingMs;
    const who = nameOf(p.by), pen = DIFFICULTIES[G.difficulty].penaltyMs;
    const penTxt = pen ? ' (−' + (pen / 1000) + ' s)' : '';
    switch (p.event) {
      case 'dial': G.dials[p.a] = p.b; break;
      case 'key':
        G.last = { event: 'key', a: p.a };
        addLog(who + ' giró la llave: ' + (p.a === 4 ? '¡se abre!' : p.a < 0 ? 'no se abre' + penTxt + '.' : p.a + ' de 4 diales correctos' + penTxt + '.'));
        break;
      case 'move_ok': G.last = { event: 'move_ok', a: 0 }; addLog(who + ' movió la ficha: avanzó.'); break;
      case 'bump': G.last = { event: 'bump', a: 0 }; addLog(who + ' movió la ficha: chocó contra un muro' + penTxt + '.'); break;
      case 'answer_wrong':
        G.last = { event: 'answer_wrong', a: p.a };
        addLog(who + ' propuso una palabra: ' + (p.a === 5 ? '¡correcta!' : p.a < 0 ? 'incorrecta' + penTxt + '.' : p.a + ' de 5 letras en su sitio' + penTxt + '.'));
        break;
    }
  },

  ROOM_SOLVED(msg) {
    G.roomsSolved = msg.payload.roomsSolved;
    if (G.roomsSolved < TOTAL_ROOMS) { G.roomTransition = true; toast('¡Sala ' + (msg.payload.room + 1) + ' resuelta!', 'good'); }
  },

  GAME_OVER(msg) { applyGameOver(msg.payload); },

  CHAT_MESSAGE(msg) {
    if (!getPlayer(msg.senderId)) return;
    G.chat.push({ by: msg.senderId, name: nameOf(msg.senderId), text: msg.payload.text });
    if (G.chat.length > 100) { G.chat.shift(); ui.chatRendered = Math.max(0, ui.chatRendered - 1); }
  },

  HEARTBEAT(msg) {
    const p = msg.payload, pl = getPlayer(msg.senderId);
    if (pl && pl.name !== p.name && msg.senderId !== me.id) pl.name = p.name;
    if (msg.senderId === G.hostId && msg.senderId !== me.id && G.phase === 'playing' && p.phase === 'playing' && p.remainingMs !== null) G.remainingMs = p.remainingMs;
  },

  STATE_SYNC_REQUEST(msg) {
    if (!amHost()) return;
    const p = getPlayer(msg.senderId);
    if (!p) { hostSendRejected(msg.senderId, 'unknown'); return; }
    p.connected = true; p.lastSeen = Date.now(); p.disconnectedAt = null; p.expiring = false;
    hostBroadcastSync(); hostSendViews(msg.senderId);
  }
};

function applyGameOver(p) {
  if (G.phase === 'over') return;
  G.phase = 'over'; G.awaitRecoverySince = null;
  G.roomsSolved = p.roomsSolved; G.remainingMs = p.remainingMs;
  G.result = { won: p.won, reason: p.reason };
  if (H) clearTimeout(H.transitionTimer);
  setScreen('result');
}

function removePlayer(id, reason) {
  const p = getPlayer(id);
  if (!p) return;
  const wasHost = id === G.hostId;
  G.players = G.players.filter(x => x.id !== id);
  toast(p.name + (reason === 'left' ? ' ha salido de la partida.' : ' se ha desconectado y ha sido retirado.'), 'bad');
  if (wasHost) electNewHost();
  if (amHost()) {
    if (G.phase === 'lobby') hostBroadcastSync();
    if (G.phase === 'playing') hostReassignOrder(id);
  }
}

// Elige al jugador conectado más antiguo (determinista en todos los clientes).
function electNewHost() {
  const old = G.hostId;
  const nh = connectedPlayers().filter(p => p.id !== old)[0];
  if (!nh) return;
  G.hostId = nh.id;
  if (G.phase === 'playing') G.awaitRecoverySince = performance.now();
  if (nh.id === me.id) {
    send('HOST_CHANGED', { newHostId: me.id, oldHostId: old });
    toast('Ahora eres el anfitrión.', '');
    if (G.phase === 'playing') hostEndGame('host_lost');
    else { H = H || newHostState(); hostBroadcastSync(); }
  } else {
    toast(nh.name + ' es ahora el anfitrión.', '');
  }
}

function handleRemoved(reason) {
  const msgs = {
    unknown: 'Estuviste desconectado más de 60 segundos y se te retiró de la partida. Puedes unirte de nuevo con el código.',
    full: 'La sala está llena (máximo 4 jugadores).',
    started: 'La partida ya ha comenzado; no se pueden unir jugadores nuevos.',
    over: 'Esa partida ya terminó.'
  };
  leaveLocal();
  showHomeError(msgs[reason] || 'Se te ha retirado de la partida.');
}

function applySync(msg) {
  const p = msg.payload;
  if (msg.senderId === me.id) return;
  if (p.rejected) {
    if (!G.joined || p.rejected === 'unknown') handleRemoved(p.rejected);
    return;
  }
  if (!p.players.some(x => x.id === me.id)) {
    if (G.joined) handleRemoved('unknown');
    return;
  }
  const prev = new Map(G.players.map(x => [x.id, x]));
  const now = Date.now();
  G.players = p.players.map(x => {
    const o = prev.get(x.id), connected = x.id === me.id ? true : x.connected;
    return { id: x.id, name: x.name, seq: x.seq, connected,
      lastSeen: (!o || (!o.connected && connected)) ? now : o.lastSeen,
      disconnectedAt: connected ? null : (o && o.disconnectedAt) || now,
      expiring: o ? o.expiring : false };
  }).sort(bySeq);
  const wasJoined = G.joined;
  G.hostId = p.hostId; G.difficulty = p.difficulty; G.roomIndex = p.roomIndex; G.remainingMs = p.remainingMs;
  G.roomsSolved = p.roomsSolved; G.used = p.used; G.max = p.max; G.order = p.order; G.dials = p.dials;
  G.awaitRecoverySince = null; G.joined = true;
  clearTimeout(ui.joinTimer);
  if (p.phase === 'over') { if (!G.result) { handleRemoved('over'); return; } }
  else if (G.phase !== p.phase || !wasJoined) G.phase = p.phase;
  if (!wasJoined) { saveSession(); setBusy(false); }
  if (G.phase === 'lobby') setScreen('lobby');
  else if (G.phase === 'playing') setScreen('game');
  scheduleRender();
}

/* ===================== 8. LÓGICA DE ANFITRIÓN ===================== */

function newHostState() {
  return { type: null, roomIndex: 0, order: [], views: {}, solution: null, maze: null, word: '',
    used: 0, max: 6, dials: [0, 0, 0, 0], locked: true, ending: false, transitionTimer: null, actTimes: {} };
}

function buildSyncPayload(rejected) {
  return {
    rejected: rejected || null, hostId: G.hostId, phase: G.phase, difficulty: G.difficulty,
    roomIndex: G.roomIndex, remainingMs: Math.max(0, Math.round(G.remainingMs)), roomsSolved: G.roomsSolved,
    used: G.used, max: G.max, order: G.order, dials: G.dials,
    players: G.players.map(p => ({ id: p.id, name: p.name, seq: p.seq, connected: p.connected }))
  };
}
function hostBroadcastSync() { if (amHost()) send('STATE_SYNC', buildSyncPayload(null)); }
function hostSendRejected(id, reason) {
  if (amHost()) send('STATE_SYNC', buildSyncPayload(reason), { topic: topicPrivate(net.roomCode, id) });
}

function hostSendViews(id) {
  if (!amHost() || !H || !H.type || H.ending) return;
  roleList(H.type).forEach(role => {
    if (roleHolder(H.type, role, H.order, H.roomIndex) === id && H.views[role]) {
      send('PRIVATE_VIEW', { room: H.roomIndex, role, data: H.views[role] }, { topic: topicPrivate(net.roomCode, id) });
    }
  });
}
function hostSendRole(role) {
  if (!H) return;
  const id = roleHolder(H.type, role, H.order, H.roomIndex);
  send('PRIVATE_VIEW', { room: H.roomIndex, role, data: H.views[role] }, { topic: topicPrivate(net.roomCode, id) });
}

function hostStartGame() {
  if (!amHost() || G.phase !== 'lobby') return;
  if (connectedPlayers().length < MIN_PLAYERS) { toast('Hacen falta al menos 2 jugadores conectados.', 'bad'); return; }
  H = newHostState();
  G.remainingMs = GAME_MS;
  if (!send('GAME_START', { difficulty: G.difficulty, totalRooms: TOTAL_ROOMS, remainingMs: GAME_MS })) {
    toast('No se pudo enviar: sin conexión con el broker.', 'bad'); return;
  }
  hostBeginRoom(0);
}

function hostBeginRoom(idx) {
  if (!H || H.ending) return;
  clearTimeout(H.transitionTimer);
  const cfg = DIFFICULTIES[G.difficulty], type = ROOM_TYPES[idx];
  H.type = type; H.roomIndex = idx; H.order = connectedPlayers().map(p => p.id);
  H.used = 0; H.locked = false; H.actTimes = {}; H.dials = [0, 0, 0, 0];
  if (type === 'dials') {
    const d = genDials(cfg);
    H.solution = d.solution; H.dials = d.dials.slice(); H.views = d.views; H.max = cfg.keys;
  } else if (type === 'maze') {
    H.maze = genMaze(cfg.maze, cfg.hideStart, cfg.colors); H.views = mazeViews(H.maze, cfg.hideStart); H.max = cfg.bumps;
  } else {
    const c = genCipher(cfg);
    H.word = c.word; H.views = c.views; H.max = cfg.tries;
  }
  H.order.forEach(hostSendViews);
  send('ROOM_START', { room: idx, max: H.max, order: H.order, remainingMs: Math.max(0, Math.round(G.remainingMs)), dials: H.dials });
}

// Si un jugador con rol sale definitivamente, otro jugador conectado hereda su sitio.
function hostReassignOrder(leftId) {
  if (!H || !H.order.includes(leftId)) return;
  const conn = connectedPlayers();
  if (!conn.length) return;
  const count = id => H.order.filter(x => x === id).length;
  const sub = conn.slice().sort((a, b) => count(a.id) - count(b.id))[0];
  H.order = H.order.map(id => id === leftId ? sub.id : id);
  G.order = H.order.slice();
  hostBroadcastSync();
  new Set(H.order).forEach(hostSendViews);
}

function hostUpdate(event, by, a, b) {
  send('ROOM_UPDATE', { room: H.roomIndex, event, by, a, b, used: H.used, max: H.max, remainingMs: Math.max(0, Math.round(G.remainingMs)) });
}

function hostOnAction(msg) {
  if (!H || H.ending || H.locked || G.phase !== 'playing' || G.roomTransition || isPaused()) return;
  const by = msg.senderId, p = getPlayer(by), a = msg.payload;
  if (!p || !p.connected) return;
  const now = Date.now();
  const times = (H.actTimes[by] = (H.actTimes[by] || []).filter(t => now - t < ACTION_LIMIT.windowMs));
  if (times.length >= ACTION_LIMIT.count) return;
  times.push(now);

  if (H.type === 'dials') {
    if (a.kind === 'dial') {
      if (!isInt(a.a, 0, 3) || (a.b !== 1 && a.b !== -1)) return;
      if (dialOwner(a.a, H.order, H.roomIndex) !== by) return;
      H.dials[a.a] = (H.dials[a.a] + a.b + 6) % 6;
      hostUpdate('dial', by, a.a, H.dials[a.a]);
    } else if (a.kind === 'key') {
      const correct = H.dials.filter((v, i) => v === H.solution[i]).length;
      if (correct < 4) hostPenalty();
      hostUpdate('key', by, correct === 4 ? 4 : (DIFFICULTIES[G.difficulty].showCount ? correct : -1), 0);
      if (correct === 4) hostSolved();
      else if (H.used >= H.max) hostEndGame('attempts');
    }
  } else if (H.type === 'maze') {
    if (a.kind !== 'move' || !isInt(a.a, 0, 3)) return;
    if (roleHolder('maze', 'mover', H.order, H.roomIndex) !== by) return;
    const m = H.maze, d = DIRS[a.a];
    if (m.walls[m.pos] & d.bit) {
      hostPenalty();
      hostUpdate('bump', by, 0, 0);
      if (H.used >= H.max) hostEndGame('attempts');
    } else {
      m.pos = (Math.floor(m.pos / m.n) + d.dr) * m.n + (m.pos % m.n) + d.dc;
      H.views.suelo = [COLORS[m.colors[m.pos]].id];
      H.views.fila = [String(Math.floor(m.pos / m.n) + 1)];
      hostUpdate('move_ok', by, 0, 0);
      hostSendRole('suelo'); hostSendRole('fila');
      if (m.pos === m.exit) hostSolved();
    }
  } else if (H.type === 'cipher') {
    if (a.kind !== 'answer' || !/^[A-Z]{5}$/.test(a.text)) return;
    const correct = a.text.split('').filter((ch, i) => ch === H.word[i]).length;
    if (correct === 5) { hostUpdate('answer_wrong', by, 5, 0); hostSolved(); return; }
    hostPenalty();
    hostUpdate('answer_wrong', by, DIFFICULTIES[G.difficulty].showCount ? correct : -1, 0);
    if (H.used >= H.max) hostEndGame('attempts');
  }
}

// Cada error gasta un intento y, en Normal y Difícil, resta tiempo.
function hostPenalty() {
  H.used++;
  G.remainingMs = Math.max(0, G.remainingMs - DIFFICULTIES[G.difficulty].penaltyMs);
}

function hostSolved() {
  H.locked = true;
  const solved = G.roomsSolved + 1;
  send('ROOM_SOLVED', { room: H.roomIndex, roomsSolved: solved, remainingMs: Math.max(0, Math.round(G.remainingMs)) });
  if (solved >= TOTAL_ROOMS) hostEndGame('solved', solved);
  else H.transitionTimer = setTimeout(() => hostBeginRoom(H.roomIndex + 1), NEXT_ROOM_DELAY_MS);
}

function hostEndGame(reason, solvedOverride) {
  if (!amHost() || G.phase === 'over') return;
  if (H) { if (H.ending) return; H.ending = true; H.locked = true; clearTimeout(H.transitionTimer); }
  send('GAME_OVER', { won: reason === 'solved', reason,
    roomsSolved: solvedOverride !== undefined ? solvedOverride : G.roomsSolved,
    remainingMs: Math.max(0, Math.round(G.remainingMs)) });
}

/* ================ 9. PRESENCIA, HEARTBEATS, TEMPORIZADOR, RECONEXIÓN ================ */

function sendHeartbeat() {
  if (!G.joined) return;
  const host = amHost();
  send('HEARTBEAT', { name: me.name, phase: G.phase, roomIndex: G.roomIndex,
    remainingMs: host && G.phase === 'playing' ? Math.max(0, Math.round(G.remainingMs)) : null, isHost: host });
}

function presenceCheck() {
  if (!G.joined || !net.online) return;
  const now = Date.now();
  let hostDown = false, someDown = false;
  for (const p of G.players) {
    if (p.id === me.id) continue;
    if (p.connected && now - p.lastSeen > OFFLINE_MS) {
      p.connected = false; p.disconnectedAt = now; someDown = true;
      if (p.id === G.hostId) hostDown = true;
    } else if (!p.connected && amHost() && !p.expiring && now - p.disconnectedAt > REJOIN_MS) {
      p.expiring = true;
      send('PLAYER_LEAVE', { playerId: p.id, reason: 'timeout' });
    }
  }
  if (hostDown) electNewHost();
  else if (someDown && amHost() && G.phase === 'lobby') hostBroadcastSync();
  if (someDown) scheduleRender();
}

function onBrokerReconnected() {
  if (!G.joined) return;
  const now = Date.now();
  G.players.forEach(p => { if (p.connected) p.lastSeen = now; });
  sendHeartbeat();
  if (!amHost()) send('STATE_SYNC_REQUEST', {});
  toast('Conexión recuperada.', 'good');
  scheduleRender();
}

let lastTick = performance.now(), tickCount = 0;
function tick() {
  const now = performance.now(), dt = now - lastTick;
  lastTick = now; tickCount++;
  if (G.joined && G.phase === 'playing' && !isPaused()) {
    G.remainingMs = Math.max(0, G.remainingMs - dt);
    if (amHost() && G.remainingMs <= 0 && H && !H.ending) hostEndGame('time');
  }
  if (G.joined && G.phase === 'playing' && G.awaitRecoverySince !== null && now - G.awaitRecoverySince > 8000) {
    applyGameOver({ won: false, reason: 'host_lost', roomsSolved: G.roomsSolved, remainingMs: Math.round(G.remainingMs) });
  }
  if (tickCount % 4 === 0) { presenceCheck(); scheduleRender(); }
  if (tickCount % 120 === 0) pruneRecentIds();
  updateTimerUI();
}

/* ===================== 10. INTERFAZ ===================== */

const $ = id => document.getElementById(id);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
function fill(container, sig, build) {
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  container.replaceChildren(...build());
}

function setScreen(name) {
  ui.screen = name;
  for (const s of ['home', 'lobby', 'game', 'result']) $('screen-' + s).hidden = s !== name;
  scheduleRender();
  const el = $({ home: 'home-title', lobby: 'lobby-title', game: 'room-label', result: 'result-title' }[name]);
  if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
}

function toast(text, kind) {
  const box = $('toasts');
  const el = h('div', { class: 'toast ' + (kind || ''), text });
  box.append(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 5000);
  while (box.children.length > 4) box.firstChild.remove();
}

function showHomeError(text) {
  const e = $('home-error');
  e.textContent = text; e.hidden = !text;
  setBusy(false);
}
function setBusy(on, status) {
  ui.busy = on;
  $('btn-create').disabled = on; $('btn-join').disabled = on;
  const s = $('home-status');
  s.textContent = on && status ? status : ''; s.hidden = !(on && status);
  if (on) $('home-error').hidden = true;
}

function updateConnBanner() {
  const b = $('conn-banner'), show = G.joined && !net.online;
  b.hidden = !show;
  if (show) b.textContent = 'Sin conexión con el broker. Reintentando… La partida seguirá cuando vuelva la conexión.';
}

function updateTimerUI() {
  const t = $('timer'), txt = formatTime(G.remainingMs);
  if (t.textContent !== txt) t.textContent = txt;
  t.classList.toggle('low', G.phase === 'playing' && G.remainingMs <= 60000);
}

function scheduleRender() {
  if (ui.renderQueued) return;
  ui.renderQueued = true;
  requestAnimationFrame(() => { ui.renderQueued = false; render(); });
}
function render() {
  updateConnBanner();
  if (ui.screen === 'lobby') renderLobby();
  else if (ui.screen === 'game') renderGame();
  else if (ui.screen === 'result') renderResult();
}

function roleLabelsOf(id) {
  if (G.phase !== 'playing' || !G.order.length) return '';
  const type = roomType();
  return rolesOf(type, G.order, G.roomIndex, id).map(r => ROLE_NAMES[type][r]).join(', ');
}
function playerRow(p, withRoles) {
  const roles = withRoles ? roleLabelsOf(p.id) : '';
  return h('li', null,
    h('strong', { text: p.name }),
    p.id === me.id ? h('span', { class: 'badge', text: 'Tú' }) : null,
    p.id === G.hostId ? h('span', { class: 'badge host', text: 'Anfitrión' }) : null,
    p.connected ? h('span', { class: 'badge on', text: '● Conectado' }) : h('span', { class: 'badge off', text: '○ Desconectado' }),
    roles ? h('span', { class: 'role-tag', text: 'Roles: ' + roles }) : null);
}

function renderLobby() {
  $('lobby-code').textContent = net.roomCode;
  const conn = connectedPlayers().length;
  $('lobby-count').textContent = 'Jugadores conectados: ' + conn + ' de ' + MAX_PLAYERS + ' (mínimo ' + MIN_PLAYERS + ').';
  fill($('lobby-players'), JSON.stringify(G.players.map(p => [p.id, p.name, p.connected, p.id === G.hostId])), () => G.players.slice().sort(bySeq).map(p => playerRow(p, false)));
  const d = DIFFICULTIES[G.difficulty];
  $('lobby-difficulty').textContent = 'Dificultad: ' + d.label + '.';
  const host = amHost();
  $('btn-start').hidden = !(host && conn >= MIN_PLAYERS);
  $('lobby-msg').textContent = host
    ? (conn >= MIN_PLAYERS ? 'Todo listo. Pulsa «Comenzar» cuando queráis empezar.' : 'Esperando a más jugadores: hacen falta al menos 2.')
    : 'Esperando a que ' + nameOf(G.hostId) + ' (anfitrión) comience la partida.';
}

const colorChip = id => { const c = colorById(id); return c ? h('span', null, h('span', { class: 'swatch', style: 'background:' + c.hex, 'aria-hidden': 'true' }), c.name) : '?'; };
const waiting = () => h('p', { class: 'muted', text: 'Esperando datos del anfitrión…' });

function mazeMap(d) {
  const rows = +d[0], cols = +d[1], sr = +d[2], sc = +d[3], er = +d[4], ec = +d[5];
  if (!(rows > 0 && cols > 0) || d.length < 6 + rows * cols) return waiting();
  const grid = h('div', { class: 'mz', style: 'grid-template-columns:repeat(' + cols + ',1fr)', role: 'img',
    'aria-label': 'Mapa del laberinto de ' + rows + ' por ' + cols + ' casillas. Norte arriba.' });
  for (let i = 0; i < rows * cols; i++) {
    const [w, ci] = d[6 + i].split(':').map(Number);
    const col = COLORS[ci] || COLORS[0];
    const r = Math.floor(i / cols), c = i % cols;
    const cls = ['mz-cell', (w & 1) ? 'wn' : '', (w & 2) ? 'we' : '', (w & 4) ? 'ws' : '', (w & 8) ? 'wo' : ''].join(' ');
    const mk = (r === sr && c === sc) ? 'Inicio' : (r === er && c === ec) ? 'Salida' : '';
    grid.append(h('div', { class: cls, style: '--c:' + col.hex }, h('span', { text: col.code }), mk ? h('span', { class: 'mk', text: mk }) : null));
  }
  return h('div', null, grid,
    h('p', { class: 'legend', text: 'Norte arriba. Los trazos gruesos son muros. Colores: Roj = rojo, Azu = azul, Ver = verde, Amb = ámbar.' + (sr < 0 ? ' Este mapa no marca el inicio: deducidlo con el suelo y la fila.' : '') }));
}

function roleBody(type, role) {
  const d = G.views[G.roomIndex + ':' + role];
  if (type === 'maze' && role === 'mover') return h('p', { text: 'Tú mueves la ficha, pero no ves el mapa. Pide indicaciones al equipo y usa los botones de dirección.' });
  if (!d) return waiting();
  const pairs = () => { const o = []; for (let i = 0; i + 1 < d.length; i += 2) o.push([d[i], d[i + 1]]); return o; };
  const key = type + '/' + role;
  switch (key) {
    case 'dials/manual': return h('ul', { class: 'plain' }, d.map((c, i) => h('li', null, 'Dial ' + (i + 1) + ' → ', colorChip(c))));
    case 'dials/regla': return h('p', { text: d.length
      ? 'Los diales ' + d.join(' y ') + ' están invertidos: hay que poner el símbolo opuesto al que indique la tabla. El opuesto está 3 puestos más allá en este círculo: Sol, Luna, Estrella, Llave, Gota, Hoja (y vuelta a Sol).'
      : 'Ningún dial está invertido.' });
    case 'dials/tabla': return h('ul', { class: 'plain' }, pairs().map(([c, s]) => h('li', null, colorChip(c), ' → ' + symLabel(s))));
    case 'maze/mapa': return mazeMap(d);
    case 'maze/suelo': return h('p', null, 'Estás pisando una casilla de color: ', colorChip(d[0]));
    case 'maze/fila': return h('p', { text: 'Estás en la fila ' + d[0] + ' (la fila 1 es la de arriba).' });
    case 'cipher/texto': return h('p', { class: 'big-word', text: d[0] });
    case 'cipher/clave': return h('p', { text: 'El símbolo clave es: ' + symLabel(d[0]) });
    case 'cipher/tabla': return h('ul', { class: 'plain' }, pairs().map(([s, n]) => h('li', { text: symLabel(s) + ' → desplazamiento ' + n })));
    case 'cipher/orden': return h('p', { text: d[0] === 'alreves' ? 'Tras descifrar, la palabra original está escrita AL REVÉS: hay que leerla de derecha a izquierda.' : 'La palabra se lee en el orden normal, de izquierda a derecha.' });
    case 'cipher/categoria': return h('p', { text: 'La palabra es de la categoría: ' + d[0] });
    default: return waiting();
  }
}

function renderPrivate() {
  const type = roomType(), roles = myRoles();
  const btn = $('btn-toggle-clues');
  btn.textContent = ui.hideClues ? 'Mostrar información' : 'Ocultar información';
  btn.setAttribute('aria-expanded', ui.hideClues ? 'false' : 'true');
  $('private-area').hidden = ui.hideClues;
  const sig = JSON.stringify([G.roomIndex, roles, roles.map(r => G.views[G.roomIndex + ':' + r])]);
  fill($('private-area'), sig, () => {
    const out = roles.map(r => h('li', null, h('h4', { text: ROLE_NAMES[type][r] }), roleBody(type, r)));
    if (type === 'dials') {
      const mine = [0, 1, 2, 3].filter(i => dialOwner(i, G.order, G.roomIndex) === me.id);
      out.push(h('li', null, h('h4', { text: 'Tus diales' }), h('p', { text: mine.length ? 'Controlas: ' + mine.map(i => 'dial ' + (i + 1)).join(', ') + '. Solo tú ves su símbolo.' : 'No controlas ningún dial.' })));
    }
    if (!out.length) out.push(h('li', { class: 'empty', text: 'En esta sala no tienes información privada.' }));
    return out;
  });
}

function renderRoomArea() {
  const type = roomType(), area = $('room-area');
  const paused = isPaused() || G.roomTransition;
  const mover = type === 'maze' && roleHolder('maze', 'mover', G.order, G.roomIndex);
  const sig = JSON.stringify([type, G.dials, G.order, G.used, G.max, G.last, paused, me.id === mover, G.players.map(p => p.name)]);
  $('answer-box').hidden = type !== 'cipher';
  fill(area, sig, () => {
    if (!G.order.length) return [waiting()];
    if (type === 'dials') {
      const cards = [0, 1, 2, 3].map(i => {
        const owner = dialOwner(i, G.order, G.roomIndex), mine = owner === me.id, v = SYMBOLS[G.dials[i]];
        return h('div', { class: 'dial-card' + (mine ? ' mine' : '') },
          h('h4', { text: 'Dial ' + (i + 1) }),
          h('p', { class: 'who', text: mine ? 'Lo controlas tú' : 'Lo controla ' + nameOf(owner) }),
          mine ? [h('div', { class: 'dial-glyph', 'aria-hidden': 'true', text: v.glyph }), h('p', { class: 'dial-name', text: v.name }),
            h('div', { class: 'dial-btns' },
              h('button', { type: 'button', class: 'btn', 'aria-label': 'Dial ' + (i + 1) + ': símbolo anterior', disabled: paused, text: 'Anterior', onclick: () => sendAction('dial', i, -1, '') }),
              h('button', { type: 'button', class: 'btn', 'aria-label': 'Dial ' + (i + 1) + ': símbolo siguiente', disabled: paused, text: 'Siguiente', onclick: () => sendAction('dial', i, 1, '') }))]
          : h('p', { class: 'dial-name', text: 'Símbolo oculto' }));
      });
      return [h('div', { class: 'dial-grid' }, cards),
        h('button', { type: 'button', class: 'btn primary', disabled: paused, text: 'Girar la llave (' + (G.max - G.used) + ' giros restantes)', onclick: () => sendAction('key', 0, 0, '') }),
        G.last && G.last.event === 'key' ? h('p', { class: 'result-line', text: G.last.a < 0 ? 'Último giro: la llave no se abre.' : 'Último giro: ' + G.last.a + ' de 4 diales correctos.' }) : h('p', { class: 'muted', text: 'Aún no habéis girado la llave.' })];
    }
    if (type === 'maze') {
      const last = G.last ? h('p', { class: 'result-line', text: G.last.event === 'bump' ? 'Último movimiento: chocó contra un muro.' : 'Último movimiento: avanzó.' }) : h('p', { class: 'muted', text: 'La ficha aún no se ha movido.' });
      if (me.id === mover) {
        return [h('p', { text: 'Tú mueves la ficha. Norte es arriba en el mapa.' }),
          h('div', { class: 'dpad' }, DIRS.map((d, i) => h('button', { type: 'button', class: 'btn ' + d.cls, disabled: paused, text: d.name, onclick: () => sendAction('move', i, 0, '') }))), last];
      }
      return [h('p', { text: 'Mueve la ficha ' + nameOf(mover) + '. Guiadle con lo que veis.' }), last];
    }
    return [h('p', { text: 'Descifrad el mensaje entre todos y escribid la palabra.' }),
      G.last && G.last.event === 'answer_wrong' ? h('p', { class: 'result-line', text: G.last.a < 0 ? 'Última respuesta: incorrecta.' : 'Última respuesta: ' + G.last.a + ' de 5 letras en su sitio.' }) : h('p', { class: 'muted', text: 'Aún no habéis enviado ninguna respuesta.' })];
  });
  $('btn-answer').disabled = paused;
}

function renderGame() {
  const type = roomType();
  $('room-label').textContent = 'Sala ' + (G.roomIndex + 1) + ' de ' + TOTAL_ROOMS + ': ' + ROOM_TITLES[type];
  $('attempts-label').textContent = COUNTER_LABELS[type] + ': ' + G.used + ' de ' + G.max;
  const dcfg = DIFFICULTIES[G.difficulty];
  $('room-intro').textContent = ROOM_INTROS[type] + (dcfg.showCount || type === 'maze' ? '' : ' No se indica cuántos aciertos hay.') +
    (dcfg.penaltyMs ? ' Cada error resta ' + (dcfg.penaltyMs / 1000) + ' segundos.' : '');
  const paused = isPaused();
  $('pause-flag').hidden = !paused;
  const st = $('game-status');
  let status = '';
  if (G.awaitRecoverySince !== null) status = 'El anfitrión se desconectó. Pausa mientras se elige un nuevo anfitrión…';
  else if (paused) status = 'Partida en pausa: hacen falta al menos 2 jugadores conectados. El tiempo está detenido.';
  else if (G.roomTransition) status = 'Sala resuelta. Preparando la siguiente sala…';
  st.textContent = status; st.hidden = !status;
  updateTimerUI();
  renderRoomArea();
  renderPrivate();
  fill($('log-list'), JSON.stringify(G.log), () => G.log.map(t => h('li', { text: t })));
  renderChat();
  fill($('game-players'), JSON.stringify([G.players.map(p => [p.id, p.name, p.connected, p.id === G.hostId]), G.order, G.roomIndex]), () => G.players.slice().sort(bySeq).map(p => playerRow(p, true)));
}

function renderChat() {
  const log = $('chat-log');
  if (ui.chatRendered > G.chat.length) { log.replaceChildren(); ui.chatRendered = 0; }
  if (ui.chatRendered === G.chat.length) return;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  for (let i = ui.chatRendered; i < G.chat.length; i++) log.append(h('li', null, h('strong', { text: G.chat[i].name + ': ' }), G.chat[i].text));
  ui.chatRendered = G.chat.length;
  if (stick) log.scrollTop = log.scrollHeight;
}

function renderResult() {
  const r = G.result || { won: false, reason: 'time' };
  $('result-title').textContent = r.won ? '¡Victoria!' : 'Derrota';
  const reasons = {
    solved: 'Habéis resuelto las tres salas a tiempo. Gran trabajo en equipo.',
    time: 'Se agotó el tiempo.',
    attempts: 'Se agotaron los intentos de la sala.',
    host_lost: 'El anfitrión se desconectó; esta partida no se puede recuperar'
  };
  $('result-reason').textContent = reasons[r.reason] || '';
  $('result-rooms').textContent = G.roomsSolved + ' de ' + TOTAL_ROOMS;
  $('result-time').textContent = formatTime(G.remainingMs);
}

/* ===================== 11. ACCIONES DEL USUARIO Y ARRANQUE ===================== */

function readName() {
  const input = $('name-input');
  const name = input.value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
  input.value = name;
  if (!name) { showHomeError('Escribe tu nombre para continuar.'); input.focus(); return null; }
  return name;
}
function getClientId() { const s = loadSession(); return s && isId(s.clientId) ? s.clientId : newClientId(); }
function connectionErrorText(err) {
  return 'No se pudo conectar con el broker MQTT (' + (err && err.message ? err.message : 'error desconocido') +
    '). Los brokers públicos pueden estar caídos o bloqueados; consulta el README para cambiar la URL.';
}

async function createRoom() {
  if (ui.busy) return;
  const name = readName(); if (!name) return;
  setBusy(true, 'Conectando con el broker…');
  resetAll();
  me.id = getClientId(); me.name = name; net.clientId = me.id;
  setRoom(newRoomCode());
  try { await connectBroker(); } catch (err) { resetAll(); showHomeError(connectionErrorText(err)); return; }
  G.joined = true; G.hostId = me.id; G.phase = 'lobby';
  G.difficulty = $('difficulty').value in DIFFICULTIES ? $('difficulty').value : 'normal';
  G.players = [makePlayer(me.id, me.name, 1)];
  H = newHostState();
  saveSession(); setBusy(false);
  setScreen('lobby');
  sendHeartbeat();
}

async function joinRoom(codeRaw, silent) {
  if (ui.busy) return;
  const code = String(codeRaw || '').trim().toUpperCase();
  if (!silent) { const name = readName(); if (!name) return; me.name = name; }
  if (!ROOM_CODE_RE.test(code)) {
    showHomeError('El código tiene 6 caracteres: letras y números, sin O, I, 0 ni 1.');
    $('code-input').focus();
    return;
  }
  setBusy(true, 'Conectando con la partida ' + code + '…');
  resetAll();
  me.id = getClientId(); net.clientId = me.id;
  setRoom(code);
  try { await connectBroker(); } catch (err) { resetAll(); showHomeError(connectionErrorText(err)); return; }
  let tries = 0;
  const attempt = () => {
    if (G.joined) return;
    if (tries++ >= 7) {
      leaveLocal();
      showHomeError('No se encontró ninguna partida con el código ' + code + ', o el anfitrión no responde.');
      return;
    }
    send('PLAYER_JOIN', { name: me.name, reconnect: !!silent });
    ui.joinTimer = setTimeout(attempt, 3000);
  };
  attempt();
}

function leaveLocal() {
  disconnectBroker();
  resetAll();
  clearSession();
  me.id = ''; net.clientId = '';
  setBusy(false);
  setScreen('home');
}
function leaveRoom() {
  if (G.joined && net.online) send('PLAYER_LEAVE', { playerId: me.id, reason: 'left' });
  const c = net.client;
  setTimeout(() => { if (c && c === net.client) leaveLocal(); }, 250);
  if (!c) leaveLocal();
}

function sendAction(kind, a, b, text) {
  const now = Date.now();
  rate.actions = rate.actions.filter(t => now - t < ACTION_LIMIT.windowMs);
  if (rate.actions.length >= ACTION_LIMIT.count) { toast('Vas demasiado rápido. Espera un momento.', 'bad'); return; }
  if (!send('ACTION', { kind, a, b, text })) { toast('No se pudo enviar: sin conexión con el broker.', 'bad'); return; }
  rate.actions.push(now);
}

function sendAnswer() {
  const input = $('answer-input');
  const text = input.value.toUpperCase().replace(/[^A-Z]/g, '');
  if (text.length !== 5) { toast('La respuesta debe tener 5 letras (A–Z, sin Ñ ni tildes).', 'bad'); return; }
  sendAction('answer', 0, 0, text);
  input.value = '';
}

function sendChat() {
  const input = $('chat-input');
  const text = input.value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 200);
  if (!text) return;
  const now = Date.now();
  rate.chat = rate.chat.filter(t => now - t < CHAT_LIMIT.windowMs);
  if (rate.chat.length >= CHAT_LIMIT.count) { toast('Vas muy rápido: máximo 5 mensajes cada 10 segundos.', 'bad'); return; }
  if (!send('CHAT_MESSAGE', { text })) { toast('No se pudo enviar: sin conexión.', 'bad'); return; }
  rate.chat.push(now);
  input.value = '';
}

function copyCode() {
  const code = net.roomCode, done = () => toast('Código ' + code + ' copiado.', 'good');
  const fallback = () => {
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' });
    ta.value = code; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('No se pudo copiar. Anota el código: ' + code, 'bad'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, fallback);
  else fallback();
}

function init() {
  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', () => joinRoom($('code-input').value, false));
  $('code-input').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('code-input').value, false); });
  $('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
  $('btn-copy').addEventListener('click', copyCode);
  $('btn-start').addEventListener('click', hostStartGame);
  $('btn-leave-lobby').addEventListener('click', leaveRoom);
  $('btn-leave-game').addEventListener('click', () => { if (confirm('¿Seguro que quieres salir de la partida?')) leaveRoom(); });
  $('btn-back-home').addEventListener('click', leaveRoom);
  $('btn-toggle-clues').addEventListener('click', () => { ui.hideClues = !ui.hideClues; scheduleRender(); });
  $('btn-answer').addEventListener('click', sendAnswer);
  $('answer-input').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('answer-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendAnswer(); });
  $('btn-chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });

  setInterval(tick, 250);
  setInterval(sendHeartbeat, HEARTBEAT_MS);

  const s = loadSession();
  if (s && isId(s.clientId) && ROOM_CODE_RE.test(s.roomCode || '') && isName(s.name)) {
    me.name = s.name;
    $('name-input').value = s.name;
    $('code-input').value = s.roomCode;
    joinRoom(s.roomCode, true);
  }
  setScreen(ui.screen);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
