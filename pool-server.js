/**
 * 极简台球 · 联机服务器
 * 零依赖：用 Node 内置模块自己实现 WebSocket。
 *
 * 启动：  node pool-server.js
 * 打开：  http://localhost:8080
 * 联机：  一方点「创建房间」拿到 4 位房号，另一方输入房号加入
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PORT = process.env.PORT || 8080;
const HTML_FILE = path.join(__dirname, 'pool.html');

// ---------------- 空闲自动退出 ----------------
// 页面开着时会每分钟发一次 /__ping，所以只要还有人在用，服务器就不会退；
// 连续 IDLE_MIN 分钟（默认 20）没有任何访问、也没有在线连接，就自动停掉，
// 顺手把随本机一起启动的那条 cloudflared 隧道（PID 记在 tunnel.pid）也关掉。
const IDLE_MIN = Number(process.env.POOL_IDLE_MINUTES || 20);
const IDLE_MS = IDLE_MIN * 60000;
let lastActivity = Date.now();
const clients = new Set();
function touch() { lastActivity = Date.now(); }

// 只杀确认是 cloudflared 的那个 PID，避免 PID 被复用后误杀别的进程
function stopTunnel() {
  const pidFile = path.join(__dirname, 'tunnel.pid');
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) || 0; } catch (e) { return; }
  try { fs.unlinkSync(pidFile); } catch (e) {}
  if (!pid || process.platform !== 'win32') return;
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      '$p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue;' +
      'if ($p -and $p.ProcessName -eq "cloudflared") { Stop-Process -Id ' + pid + ' -Force }'
    ], { windowsHide: true, timeout: 8000 });
  } catch (e) {}
}

function shutdownIdle() {
  console.log('[空闲] ' + IDLE_MIN + ' 分钟没有访问，自动停止服务器（隧道一并关闭）');
  stopTunnel();
  try { server.close(); } catch (e) {}
  setTimeout(function () { process.exit(0); }, 400);
}

// ---------------- HTTP ----------------
const server = http.createServer(function (req, res) {
  const url = req.url.split('?')[0];

  // 页面心跳：说明还有人开着页面，不算“有人访问”，但会刷新空闲计时
  if (url === '/__ping') {
    touch();
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (url === '/__status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      port: Number(PORT),
      clients: clients.size,
      rooms: rooms.size,
      idleSeconds: Math.round((Date.now() - lastActivity) / 1000),
      idleLimitSeconds: IDLE_MIN * 60
    }));
    return;
  }

  touch();
  if (url === '/' || url === '/pool.html' || url === '/index.html') {
    fs.readFile(HTML_FILE, function (err, buf) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('找不到 pool.html，请把它和 server.js 放在同一目录');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// ---------------- WebSocket 握手 ----------------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', function (req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  touch();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  new Client(socket);
});

// ---------------- 帧编解码 ----------------
function encode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  return Buffer.concat([head, payload]);
}

function decode(buf) {
  const out = { frames: [], rest: buf };
  while (out.rest.length >= 2) {
    const b = out.rest;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < 4) break;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) break;
      len = Number(b.readBigUInt64BE(2)); off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) break;

    const mask = masked ? b.slice(off, off + 4) : null;
    off += maskLen;
    const payload = Buffer.from(b.slice(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    out.frames.push({ opcode, fin, payload });
    out.rest = b.slice(off + len);
  }
  return out;
}

// ---------------- 房间 ----------------
const rooms = new Map();   // code -> { a: Client, b: Client|null, state: any }

let nextId = 1;

class Client {
  constructor(socket) {
    this.socket = socket;
    this.id = nextId++;
    this.buf = Buffer.alloc(0);
    this.room = null;
    this.seat = -1;
    this.alive = true;
    clients.add(this);
    touch();

    socket.on('data', (chunk) => {
      touch();
      this.buf = Buffer.concat([this.buf, chunk]);
      const { frames, rest } = decode(this.buf);
      this.buf = rest;
      for (const f of frames) this.onFrame(f);
    });
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  send(obj) {
    if (!this.alive) return;
    try { this.socket.write(encode(JSON.stringify(obj))); } catch (e) { /* ignore */ }
  }

  onFrame(f) {
    if (f.opcode === 0x8) { this.close(); return; }          // close
    if (f.opcode === 0x9) {                                   // ping
      try { this.socket.write(Buffer.from([0x8a, 0])); } catch (e) {}
      return;
    }
    if (f.opcode !== 0x1) return;                             // 只处理文本
    let msg;
    try { msg = JSON.parse(f.payload.toString('utf8')); } catch (e) { return; }
    handle(this, msg);
  }

  close() {
    this.alive = false;
    try { this.socket.end(); } catch (e) {}
    this.onClose();
  }

  onClose() {
    clients.delete(this);
    touch();
    if (!this.alive && !this.room) return;
    this.alive = false;
    const r = this.room;
    if (r) {
      const other = r.a === this ? r.b : r.a;
      if (other && other.alive) other.send({ t: 'peer', event: 'left' });
      if (r.a === this) r.a = r.b, r.b = null;
      else r.b = null;
      if (!r.a && !r.b) rooms.delete(r.code);
    }
    this.room = null;
  }
}

function makeCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-4);
}

function handle(client, msg) {
  switch (msg.t) {
    case 'create': {
      if (client.room) return client.send({ t: 'error', msg: '你已经在房间里了' });
      const code = makeCode();
      const room = { code, a: client, b: null, state: msg.state || null };
      rooms.set(code, room);
      client.room = room;
      client.seat = 0;
      client.send({ t: 'created', code, seat: 0 });
      console.log('[房间] 创建', code, '在线', rooms.size);
      break;
    }
    case 'join': {
      if (client.room) return client.send({ t: 'error', msg: '你已经在房间里了' });
      const room = rooms.get(String(msg.code || '').trim());
      if (!room) return client.send({ t: 'error', msg: '房间不存在' });
      if (room.b && room.b.alive) return client.send({ t: 'error', msg: '房间已满' });
      room.b = client;
      client.room = room;
      client.seat = 1;
      client.send({ t: 'joined', code: room.code, seat: 1, state: room.state });
      room.a.send({ t: 'peer', event: 'joined' });
      console.log('[房间] 加入', room.code);

      // 两人到齐 → 掷骰子决定先手（奇数玩家1，偶数玩家2）
      const die = 1 + Math.floor(Math.random() * 6);
      console.log('[房间] 掷骰子', room.code, '→', die, die % 2 ? '玩家1 开球' : '玩家2 开球');
      const broadcast = function () {
        [room.a, room.b].forEach(function (c) {
          if (c && c.alive) c.send({ t: 'dice', value: die });
        });
      };
      setTimeout(broadcast, 250);
      break;
    }
    case 'sync': {
      const room = client.room;
      if (!room) return;
      room.state = msg.state;
      const other = room.a === client ? room.b : room.a;
      if (other && other.alive) other.send({ t: 'sync', state: msg.state });
      break;
    }
    case 'shot': {
      const room = client.room;
      if (!room) return;
      const other = room.a === client ? room.b : room.a;
      if (other && other.alive) other.send({ t: 'shot', shot: msg.shot });
      break;
    }
    case 'aim': {
      const room = client.room;
      if (!room) return;
      const other = room.a === client ? room.b : room.a;
      if (other && other.alive) other.send({ t: 'aim', aim: msg.aim, strike: msg.strike });
      break;
    }
    case 'leave': {
      if (client.room) {
        const room = client.room;
        const other = room.a === client ? room.b : room.a;
        if (other && other.alive) other.send({ t: 'peer', event: 'left' });
        if (room.a === client) room.a = room.b, room.b = null;
        else room.b = null;
        if (!room.a && !room.b) rooms.delete(room.code);
        client.room = null;
        client.seat = -1;
      }
      client.send({ t: 'left' });
      break;
    }
    default:
      break;
  }
}

// ---------------- 空闲计时 ----------------
// 只要还有在线连接，或者 IDLE_MS 内有过访问（含页面心跳），就不退出。
if (IDLE_MIN > 0) {
  const every = Math.max(1000, Math.min(30000, IDLE_MS / 4));
  const timer = setInterval(function () {
    if (clients.size === 0 && Date.now() - lastActivity > IDLE_MS) {
      clearInterval(timer);
      shutdownIdle();
    }
  }, every);
  timer.unref && timer.unref();
}

server.listen(PORT, function () {
  const nets = require('os').networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach(function (k) {
    (nets[k] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    });
  });
  console.log('🎱 台球服务器已启动');
  console.log('   本机：  http://localhost:' + PORT);
  ips.forEach(function (ip) { console.log('   局域网：http://' + ip + ':' + PORT); });
  console.log('   房间会在双方都离开后自动销毁');
  if (IDLE_MIN > 0) {
    console.log('   省电模式：' + IDLE_MIN + ' 分钟没人用就自动关闭（隧道一起关）');
  } else {
    console.log('   省电模式：已关闭（一直运行）');
  }
});
