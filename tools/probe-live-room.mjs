/**
 * 线上房间服务协议核对
 * ------------------------------------------------------------------
 * 前面的联机自检都是打在本地模拟房间服务上的，所以必须再拿**线上真服务**
 * 核一遍报文字段 —— 只要 op 名字或 welcome/member_joined 的字段与
 * js/net/session.js 的期望有一点偏差，线上就会直接不能联机，而本地全绿。
 *
 * 跑法：node tools/probe-live-room.mjs <token>
 */
const HOST = process.env.GH_HOST || '101.43.19.238';
const GAME_ID = process.env.GH_GAME_ID || '06817cbb13e4ce23';
const TOKEN = process.argv[2] || process.env.GH_TOKEN || '';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; failures.push(label); console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) {
  console.error('用法：node tools/probe-live-room.mjs <token>');
  process.exit(2);
}

/** 一个连到线上 /ws/rooms 的客户端，收到的下行报文按 op 归档 */
class Peer {
  constructor(tag) {
    this.tag = tag;
    this.msgs = [];
  }

  async connect() {
    this.ws = new WebSocket(`ws://${HOST}/ws/rooms?token=${encodeURIComponent(TOKEN)}`);
    this.ws.onmessage = (ev) => {
      try {
        this.msgs.push(JSON.parse(ev.data));
      } catch (e) { /* 非 JSON 直接忽略 */ }
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('WebSocket 连接失败'));
      setTimeout(() => rej(new Error('WebSocket 连接超时')), 8000);
    });
    return this;
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** 等一条指定 op 的下行 */
  async wait(op, ms = 6000) {
    const till = Date.now() + ms;
    while (Date.now() < till) {
      const hit = this.msgs.find((m) => m.op === op);
      if (hit) return hit;
      await sleep(120);
    }
    return null;
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

console.log(`\n== 线上房间服务：http://${HOST} ==`);

// ---------------- REST ----------------
const auth = { Authorization: 'Bearer ' + TOKEN };
const created = await fetch(`http://${HOST}/api/v1/rooms`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ game_id: GAME_ID, max_players: 4 })
}).then((r) => r.json());
ok(created.ok === true && !!created.room, '建房接口可用');
const room = created.room || {};
const code = room.code || '';
ok(/^[A-Z0-9]{4,8}$/.test(code), `房间号形如 ${code}`);
// roomState.js 的房间列表就是直接读这几个字段渲染的
for (const key of ['code', 'max_players', 'member_count', 'members', 'host_id']) {
  ok(key in room, `建房返回带字段 ${key}`);
}
ok(room.max_players === 4, `人数上限按请求设成 4（实际 ${room.max_players}）`);

const listed = await fetch(
  `http://${HOST}/api/v1/rooms?game_id=${encodeURIComponent(GAME_ID)}`,
  { headers: auth }
).then((r) => r.json());
ok(Array.isArray(listed.rooms), '列房接口返回数组');
ok(
  (listed.rooms || []).some((r) => r.code === code),
  '刚建的房间出现在列表里'
);

// ---------------- WebSocket ----------------
const a = await new Peer('A').connect().catch((e) => {
  ok(false, 'WebSocket 连接：' + e.message);
  return null;
});
if (!a) {
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}
ok(true, 'WebSocket 握手成功（token 走 query 参数）');

a.send({ op: 'ping' });
ok(!!(await a.wait('pong', 4000)), '心跳 ping → pong');

a.send({ op: 'join', room: code });
const welA = await a.wait('welcome');
ok(!!welA, '加入房间后收到 welcome');
if (welA) {
  // session.js 读的是 you.seat / you.client_id 与 room.members[].{seat,client_id,user_id,username}
  ok(!!welA.you && typeof welA.you.seat === 'number', `welcome.you.seat = ${welA.you && welA.you.seat}`);
  ok(!!welA.you && !!welA.you.client_id, 'welcome.you.client_id 存在');
  ok(!!welA.room && Array.isArray(welA.room.members), 'welcome.room.members 是数组');
  const m = (welA.room.members || [])[0] || {};
  for (const key of ['seat', 'client_id', 'user_id', 'username']) {
    ok(key in m, `成员字段 ${key} 存在`);
  }
}

const b = await new Peer('B').connect();
b.send({ op: 'join', room: code });
const welB = await b.wait('welcome');
ok(!!welB, '第二个连接也能加入同一个房间');
ok(welB && welB.you.seat === 1, `第二个人坐 1 号位（实际 ${welB && welB.you.seat}）`);
const joinedEvt = await a.wait('member_joined');
ok(!!joinedEvt, 'A 收到 member_joined');
ok(
  !!joinedEvt && !!joinedEvt.room && joinedEvt.room.members.length === 2,
  'member_joined 带着完整名册（2 人）'
);

// 自定义报文：广播与单播，正是 stageSync 全部同步流量走的通道
b.msgs.length = 0;
a.send({ op: 'broadcast', data: { t: 'h', n: '阿飞' } });
const bcast = await b.wait('message');
ok(!!bcast, 'broadcast 能送到另一端');
ok(
  !!bcast && bcast.data && bcast.data.t === 'h' && bcast.data.n === '阿飞',
  '报文体原样送达（含中文）'
);
ok(!!bcast && bcast.from === welA.you.client_id, 'message.from 是发送者的 client_id');

a.msgs.length = 0;
b.send({ op: 'send', to: welA.you.client_id, data: { t: 'i', x: 375 } });
const uni = await a.wait('message');
ok(!!uni && uni.data && uni.data.x === 375, '单播（guest 上报输入用的通道）可用');

// 8KB 上限：快照报文会贴着这个上限走，得确认大包不会把连接打断
b.msgs.length = 0;
const big = { t: 's', pad: 'x'.repeat(7000) };
a.send({ op: 'broadcast', data: big });
const bigHit = await b.wait('message', 6000);
ok(!!bigHit && bigHit.data && bigHit.data.pad.length === 7000, '约 7KB 的大报文可以通过');
ok(a.ws.readyState === 1, '发过大报文后连接仍然健康');

// 离开
b.msgs.length = 0;
a.send({ op: 'leave' });
ok(!!(await a.wait('left', 4000)), '离开房间收到 left');
const leftEvt = await b.wait('member_left');
ok(!!leftEvt, 'B 收到 member_left');
ok(
  !!leftEvt && !!leftEvt.member && leftEvt.member.client_id === welA.you.client_id,
  'member_left 带着离开者的 client_id（主机掉线判定要用）'
);

a.close();
b.close();
await sleep(300);

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
