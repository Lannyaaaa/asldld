// server.js — игровой сервер + раздача файлов
// Запуск:  npm install ws  ->  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

/* ---------- точки возрождения (подальше от препятствий) ---------- */
const SPAWNS = [[-18,-18],[18,18],[-18,18],[18,-18],[0,-19],[0,19]];

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.ico':'image/x-icon'
};

/* ---------- статика ---------- */
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------- websocket ---------- */
const wss = new WebSocket.Server({ server });

const slots = [null, null];   // два игровых слота
let state = null;             // состояние матча

function resetGame() {
  state = {
    pos:   [{x:-18,z:-18}, {x:18,z:18}],
    yaw:   [0, Math.PI],
    pitch: [0, 0],
    hp:    [100, 100],
    score: [0, 0],
    dead:  [false, false],
    timers:[null, null]
  };
}

function snapshot() {
  return { pos: state.pos, yaw: state.yaw, pitch: state.pitch,
           hp: state.hp, score: state.score, dead: state.dead };
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj, except) {
  for (const ws of slots) if (ws && ws !== except) send(ws, obj);
}
function syncAll() {
  const count = (slots[0] ? 1 : 0) + (slots[1] ? 1 : 0);
  for (let i = 0; i < 2; i++) {
    if (slots[i]) send(slots[i], { t:'sync', index:i, count, state:snapshot() });
  }
}

wss.on('connection', (ws) => {
  let idx = -1;
  if (!slots[0]) idx = 0;
  else if (!slots[1]) idx = 1;

  if (idx === -1) {
    send(ws, { t:'full' });
    setTimeout(() => ws.close(), 100);
    return;
  }

  slots[idx] = ws;
  ws.playerIndex = idx;

  const both = !!(slots[0] && slots[1]);
  if (both || !state) resetGame();   // новый матч при полном составе
  syncAll();

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!state) return;

    if (m.t === 'state') {
      state.pos[idx].x = +m.x || 0;
      state.pos[idx].z = +m.z || 0;
      state.yaw[idx]   = +m.yaw || 0;
      state.pitch[idx] = +m.pitch || 0;
      broadcast({ t:'state', index:idx, x:state.pos[idx].x, z:state.pos[idx].z,
                  yaw:state.yaw[idx], pitch:state.pitch[idx] }, ws);

    } else if (m.t === 'shot') {
      broadcast({ t:'shot', index:idx, from:m.from, to:m.to }, ws);

    } else if (m.t === 'hit') {
      const target = m.target;
      if ((target === 0 || target === 1) && target !== idx && !state.dead[target]) {
        state.hp[target] = Math.max(0, state.hp[target] - 25);
        if (state.hp[target] === 0) {
          state.dead[target] = true;
          state.score[idx]++;
          scheduleRespawn(target, idx);
        }
        broadcast({ t:'hp', hp:state.hp, scores:state.score, dead:state.dead });
      }
    }
  });

  ws.on('close', () => {
    slots[idx] = null;
    if (state && state.timers[idx]) { clearTimeout(state.timers[idx]); state.timers[idx] = null; }
    if (!slots[0] && !slots[1]) { state = null; return; }
    syncAll();      // сообщаем оставшемуся игроку, что он один
  });
});

function scheduleRespawn(i, killer) {
  if (state.timers[i]) clearTimeout(state.timers[i]);
  state.timers[i] = setTimeout(() => {
    if (!state || !slots[i]) return;
    state.timers[i] = null;

    const kp = state.pos[killer];
    let best = SPAWNS[0], bestD = -1;
    for (const s of SPAWNS) {
      const d = (s[0]-kp.x)**2 + (s[1]-kp.z)**2 + Math.random()*30;
      if (d > bestD) { bestD = d; best = s; }
    }
    state.pos[i].x = best[0];
    state.pos[i].z = best[1];
    state.hp[i] = 100;
    state.dead[i] = false;
    const yaw = Math.atan2(-(kp.x - best[0]), -(kp.z - best[1]));
    state.yaw[i] = yaw;

    broadcast({ t:'respawn', index:i, x:best[0], z:best[1], yaw });
    broadcast({ t:'hp', hp:state.hp, scores:state.score, dead:state.dead });
  }, 2000);
}

/* ---------- старт ---------- */
server.listen(PORT, () => {
  console.log('\n  Сервер запущен. Откройте в браузере:');
  console.log('    http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      if (ni.family === 'IPv4' && !ni.internal) {
        console.log('    http://' + ni.address + ':' + PORT + '   (' + name + ')');
      }
    }
  }
  console.log('\n  Эту же ссылку откройте на втором ПК в локальной сети.\n');
});