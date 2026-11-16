/**
 * 联机端到端冒烟测试（零依赖，Node 21+ 自带 WebSocket）
 *
 *   node tests/e2e-online.mjs
 *
 * 起一个临时服务器（端口 8099），模拟两个浏览器：建房 → 加入 → 掷骰子 →
 * 状态快照同步 → 一杆转发，全流程断言。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.TEST_PORT || 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const log = (...a) => console.log('·', ...a);
let failed = 0;
function assert(cond, name) {
  if (cond) log('PASS', name);
  else { failed++; console.error('FAIL', name); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 起服务器
const srv = spawn(process.execPath, ['pool-server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), POOL_IDLE_MINUTES: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => process.stdout.write('  [srv] ' + d));
srv.stderr.on('data', (d) => process.stderr.write('  [srv!] ' + d));

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/__status');
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('服务器没起来');
}

// 一个最小 WS 客户端：收到的消息进队列，按类型等待
function connect() {
  const ws = new WebSocket(WS);
  const queue = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // 有等待者就直接交付（不再入队，否则同一条消息会被取两次）
    const i = waiters.findIndex((w) => w.t === msg.t);
    if (i >= 0) { waiters.splice(i, 1)[0].resolve(msg); return; }
    queue.push(msg);
  };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return {
    ws,
    ready,
    send: (o) => ws.send(JSON.stringify(o)),
    want(t, ms = 3000) {
      const hit = queue.find((m) => m.t === t);
      if (hit) { queue.splice(queue.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等不到消息 ' + t)), ms);
        waiters.push({ t, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

try {
  const status = await waitUp();
  assert(status.ok === true && status.port === Number(PORT), '服务器启动 /__status 正常');

  const html = await fetch(BASE + '/');
  const body = await html.text();
  assert(html.status === 200 && body.includes('台球'), '静态页 pool.html 能通过服务器访问');

  const A = connect();
  const B = connect();
  await Promise.all([A.ready, B.ready]);
  log('两个客户端已连接');

  // A 建房
  A.send({ t: 'create', state: { balls: [{ n: 0, x: 100, y: 200, potted: false }], turn: 0, groups: [null, null], open: true, shots: 0 } });
  const created = await A.want('created');
  assert(/^\d{4}$/.test(created.code), '建房返回 4 位房号：' + created.code);
  assert(created.seat === 0, '建房者座位 = 0');

  // B 加入
  B.send({ t: 'join', code: created.code });
  const joined = await B.want('joined');
  assert(joined.seat === 1, '加入者座位 = 1');
  assert(joined.state && joined.state.balls.length === 1, '加入时收到房主快照');

  const peer = await A.want('peer');
  assert(peer.event === 'joined', '房主收到对手加入通知');

  // 双方都收到骰子
  const [dA, dB] = await Promise.all([A.want('dice'), B.want('dice')]);
  assert(dA.value >= 1 && dA.value <= 6 && dA.value === dB.value, '双方收到同一点数：' + dA.value);

  // 快照同步：A → 服务器 → B
  B.send({ t: 'sync', state: { balls: [{ n: 8, x: 500, y: 300, potted: true }], turn: 1, groups: [0, 1], open: false, shots: 3 } });
  const sync = await A.want('sync');
  assert(sync.state.balls[0].n === 8 && sync.state.balls[0].potted === true, '快照同步（含球号与落袋）到对手');

  // 一杆转发
  A.send({ t: 'shot', shot: { aim: { x: 0.7, y: -0.7 }, strike: { x: 0, y: 0.5 }, power: 0.83 } });
  const shot = await B.want('shot');
  assert(Math.abs(shot.shot.power - 0.83) < 1e-6 && shot.shot.strike.y === 0.5, '一杆参数转发到对手');

  // 瞄准线转发
  B.send({ t: 'aim', aim: { x: -0.3, y: 0.9 }, strike: { x: 0, y: 0 } });
  const aim = await A.want('aim');
  assert(aim.aim.x === -0.3, '瞄准线转发');

  // 房号校验
  const C = connect();
  await C.ready;
  C.send({ t: 'join', code: '0000' });
  const err = await C.want('error');
  assert(/不存在/.test(err.msg), '加入不存在的房间被拒绝');
  C.close();

  // 满员校验
  const D = connect();
  await D.ready;
  D.send({ t: 'join', code: created.code });
  const full = await D.want('error');
  assert(/满/.test(full.msg), '第三人加入被拒绝（房间已满）');
  D.close();

  // 离开
  B.send({ t: 'leave' });
  await B.want('left');
  const left = await A.want('peer');
  assert(left.event === 'left', '对手离开时房主收到通知（收到：' + JSON.stringify(left) + '）');

  A.close();
  B.close();
  await sleep(300);
  const after = await (await fetch(BASE + '/__status')).json();
  assert(after.clients === 0, '全部断开后在线连接归零');
  assert(after.rooms === 0, '房间自动销毁');
} catch (e) {
  failed++;
  console.error('FAIL 异常：', e.message);
} finally {
  srv.kill();
  await sleep(200);
  console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}
