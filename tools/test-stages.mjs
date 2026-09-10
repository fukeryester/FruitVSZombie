/**
 * 真实关卡的四端联机集成自检
 * ------------------------------------------------------------------
 * 与 test-mp.mjs 的分工：那边用极简 state 精确验同步层协议；这边把
 * **真正的 Main + LobbyState / RoomState / FruitMergeState /
 * FruitVsZombieState / ResultState** 在 node 里跑起来（四份），
 * 每帧都真的 update + render 一遍，用来抓：
 *   · 联机分支里的空引用 / 未定义方法（渲染路径尤其容易漏）；
 *   · host 与 guest 的世界是否真的收敛；
 *   · 阶段切换、选卡、死亡结算、复活在真实 state 上是否走得通。
 *
 * 跑法：node tools/test-stages.mjs
 */
import './wx-node-shim.mjs';

// 主循环由本测试手动驱动，不让 Main 自己转起来
globalThis.requestAnimationFrame = () => 0;

import * as hub from './mock-hub.mjs';
import { __setSdkFactory } from '../js/net/roomClient.js';
import Main from '../js/main.js';
import { M } from '../js/net/protocol.js';
import { clearBoard, loadBoard } from '../js/core/leaderboard.js';
import { MAX_PLAYERS } from '../js/config/net.js';

__setSdkFactory(hub.MockClient);

let pass = 0;
let fail = 0;
const failures = [];
const errors = [];

function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fail++;
    failures.push(label);
    console.log('  FAIL ' + label);
  }
}
function section(n) { console.log('\n== ' + n + ' =='); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把 console.error 收集起来：Main.loop 之外的地方也可能吞异常
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

// ---------------- 四个客户端 ----------------
const NAMES = ['阿飞', '小雷', '橘子皇', 'Kart4'];
const games = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  const g = new Main();
  g.setPlayerName(NAMES[i]);
  g.net.gameId = 'testgame';
  games.push(g);
}

/** 手动跑一帧：update + render（render 会走到所有联机 HUD 分支） */
function frame(dt = 1 / 30) {
  for (const g of games) {
    if (g.net) g.net.update();
    g.states.update(dt);
    g.states.render(g.ctx);
  }
}

async function frames(n, dt = 1 / 30) {
  for (let i = 0; i < n; i++) {
    frame(dt);
    await sleep(Math.round(dt * 1000));
  }
}

const stateName = (g) => (g.states.current ? g.states.current.getName() : '(none)');

/**
 * 一直跑帧直到条件成立（或跑满上限）。
 * 联机链路里「事情发生」和「所有人都知道」之间隔着限流队列与快照节拍，
 * 固定帧数等待会随机踩空，所以凡是跨端生效的断言都用这个来等。
 */
async function waitUntil(pred, maxFrames = 120, dt = 1 / 30) {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return true;
    frame(dt);
    await sleep(Math.round(dt * 1000));
  }
  return pred();
}

/**
 * 把积压的选卡事件全部消化掉。
 * 玩到一定合成数会自动排队选卡，队列可能不止一次；不清空的话游戏一直暂停，
 * 后面的阶段推进就永远等不到。这里每轮让每个人随手点一张、剩下的靠超时代选。
 */
async function drainCardVotes(maxRounds = 12) {
  for (let r = 0; r < maxRounds; r++) {
    const host = games[0].states.current;
    if (!host.cardSystem) return;
    if (!host.cardSystem.active && !host.cardSystem.queue.length) return;
    await frames(6);
    for (const g of games) {
      const cs = g.states.current.cardSystem;
      if (cs && cs.active && !cs.overlay.locked && cs.overlay.cards.length) {
        cs._onLocalPick(cs.overlay.cards[0]);
      }
    }
    if (host.cardSystem.vote) host.cardSystem.vote.deadline = Date.now() - 1;
    await frames(10);
  }
}

section('1. 进入联机房间');
ok(games.every((g) => !!g.net), '四端都探测到联机能力（注入的 SDK 生效）');
ok(stateName(games[0]) === 'LobbyState', '启动后在大厅');

// 全部切到房间界面
for (const g of games) g.states.switchTo(g.createRoomState());
await frames(6);
ok(games.every((g) => stateName(g) === 'RoomState'), '四端都进入房间界面');
ok(games.every((g) => g.net.connected), '四端都连上了房间服务');

// 0 号建房，其余按房间号加入
const code = await games[0].net.host();
ok(!!code, `房主建房成功：${code}`);
for (let i = 1; i < games.length; i++) {
  const okJoin = await games[i].net.joinRoom(code);
  if (!okJoin) ok(false, `玩家 ${NAMES[i]} 加入失败：${games[i].net.lastError}`);
}
await frames(10);
ok(games[0].net.playerCount === 4, `房间内 4 人（实际 ${games[0].net.playerCount}）`);
ok(
  games[3].net.roster.map((m) => m.name).join(',') === NAMES.join(','),
  '四个人的昵称在名册里都对上了'
);

section('2. 房主开局 → 四端都进入第一阶段');
// 房主点「开始」：RoomState._start 会 beginMatchAsHost + 广播 STAGE
games[0].states.current._start();
await frames(12);
ok(
  games.every((g) => stateName(g) === 'FruitMergeState'),
  `四端都切到了 FruitMergeState（${games.map(stateName).join(' / ')}）`
);
ok(games[0].net.inMatch && games[3].net.inMatch, '四端会话都进入 MATCH 阶段');
ok(games[0].states.current.sync.isHost, '房主是 host');
ok(games.slice(1).every((g) => g.states.current.sync.isGuest), '其余三端是 guest');

section('3. 第一阶段：投放 / 快照收敛 / 得分归属');
{
  // 每个人各投几次（guest 走"上报给 host"，host 直接落地）
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < games.length; i++) {
      const st = games[i].states.current;
      st.touchX = 120 + i * 150;
      st._dropCurrent();
    }
    await frames(14);
  }
  await frames(40);

  const host = games[0].states.current;
  const hostAlive = host.world.bodies.filter((b) => !b.dead);
  ok(hostAlive.length >= 4, `host 场上有 ${hostAlive.length} 颗水果`);
  for (let i = 1; i < games.length; i++) {
    const gb = games[i].states.current.world.bodies;
    ok(
      Math.abs(gb.length - hostAlive.length) <= 2,
      `guest${i} 收到 ${gb.length} 颗（host ${hostAlive.length}），数量收敛`
    );
  }
  const owners = new Set(hostAlive.map((b) => b.owner));
  ok(owners.size >= 2, `场上水果来自 ${owners.size} 个不同的投放者（得分归属可区分）`);
  ok(
    host.seatScores.filter((v) => v > 0).length >= 1,
    `分数按座位记账：${host.seatScores.join('/')}`
  );
  ok(
    games[2].states.current.score === games[0].states.current.score,
    'guest 的总分与 host 一致（由快照下发）'
  );
}

section('4. 第一阶段：共享选卡');
{
  const host = games[0].states.current;
  // 先把上一节玩出来的积压选卡清干净，保证这一节测的是一次干净的投票
  await drainCardVotes();
  host.cardSystem.trigger();
  await frames(10);
  const opened = games.filter((g) => g.states.current.cardSystem.active).length;
  ok(opened === 4, `四端同时弹出选卡浮层（${opened}/4）`);
  ok(
    games.every((g) => g.states.current.cardSystem.overlay.remainSeconds() > 0),
    '浮层上有倒计时'
  );

  // 三个人各点一张，第四个人不点
  for (let i = 0; i < 3; i++) {
    const cs = games[i].states.current.cardSystem;
    cs._onLocalPick(cs.overlay.cards[i % cs.overlay.cards.length]);
  }
  await frames(10);
  ok(
    games[0].states.current.cardSystem.vote &&
    games[0].states.current.cardSystem.vote.picks.size === 3,
    'host 收到三份选择，等第四份'
  );

  // 拨过截止时间 → host 收口，未选的人随机代选
  const voteId = games[0].states.current.cardSystem.vote.id;
  games[0].states.current.cardSystem.vote.deadline = Date.now() - 1;
  await frames(14);
  const done = games.filter((g) => {
    const cs = g.states.current.cardSystem;
    return !cs.vote || cs.vote.id !== voteId;   // 这一轮投票已收口（可能已开下一轮）
  }).length;
  ok(done === 4, `四端这轮投票都已收口（${done}/4）`);
  await drainCardVotes();
  const closed = games.filter((g) => !g.states.current.cardSystem.active).length;
  ok(closed === 4, `选卡队列清空后四端都恢复游戏（${closed}/4）`);
}

section('5. 晋级第二阶段（僵尸战场）');
{
  const host = games[0].states.current;
  // 直接把分数顶到目标线，走正常晋级流程
  host.score = host.goal + 50;
  host.seatScores[0] = host.score;
  // 晋级有一段横幅倒计时（PROMOTE_DELAY），要给足时间
  for (let i = 0; i < 8 && stateName(games[0]) === 'FruitMergeState'; i++) {
    await frames(20);
    await drainCardVotes();
  }
  await frames(20);
  ok(
    games.every((g) => stateName(g) === 'FruitVsZombieState'),
    `四端都晋级到了 FruitVsZombieState（${games.map(stateName).join(' / ')}）`
  );

  const z = games[0].states.current;
  ok(z.sync.isHost, '第二阶段 host 身份延续');
  ok(z.coreMaxHp > 0 && z.maxHp > 0, `按 4 人放大：尸核 ${z.coreMaxHp} 血 / 全队 ${z.maxHp} 血`);
  ok(z.core && !z.core.dead, 'host 侧尸核就位');
  ok(z.world.walls.length > 10, `host 侧血墙 ${z.world.walls.length} 段`);

  await frames(60);
  for (let i = 1; i < games.length; i++) {
    const gz = games[i].states.current;
    ok(gz.world.walls.length === z.world.walls.length, `guest${i} 的墙体与 host 一致（按场地描述重建）`);
    ok(!!gz.core && !gz.core.dead, `guest${i} 能从快照里还原出尸核`);
    ok(
      (gz.artifacts || []).length === z.artifacts.length,
      `guest${i} 的神器数量与 host 一致（${(gz.artifacts || []).length} vs ${z.artifacts.length}）`
    );
  }
}

section('6. 第二阶段：僵尸 / 投放 / 血量共享');
{
  const z = games[0].states.current;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < games.length; i++) {
      const st = games[i].states.current;
      st.touchX = 100 + i * 160;
      st._dropCurrent();
    }
    await frames(16);
  }
  await frames(60);

  const zombies = z.world.bodies.filter((b) => b.isZombie && !b.dead).length;
  ok(zombies > 0, `host 场上刷出了 ${zombies} 只僵尸`);
  const gz = games[1].states.current;
  const gzombies = gz.world.bodies.filter((b) => b.isZombie).length;
  ok(gzombies > 0, `guest1 能看到 ${gzombies} 只僵尸`);
  ok(gz.hp === z.hp, `全队血量共享：host ${z.hp} / guest1 ${gz.hp}`);
  ok(gz.core.hp === Math.max(0, Math.round(z.core.hp)), `尸核血量同步：${gz.core.hp}`);
  ok(
    games.slice(1).every((g) => g.states.current.sync.remoteViews().length === 3),
    '每个 guest 都能看到另外三个人的投射口'
  );
  ok(z.sync.remoteViews().length === 3, 'host 也能看到另外三个人的投射口');
}

section('7. 死亡结算 → 四端计分板一致');
{
  clearBoard();
  const z = games[0].states.current;
  z.seatScores = [310, 820, 155, 640];
  z.score = 1925;
  z.hp = 1;                                   // 下一次僵尸越线就团灭
  // 直接把一只僵尸挪到警戒线上方，触发正常的越线扣血 → 死亡流程
  const zb = z.world.bodies.find((b) => b.isZombie && !b.dead);
  if (zb) { zb.y = z.warnY - zb.r - 1; }
  await waitUntil(() => games.every((g) => stateName(g) === 'ResultState'));

  ok(stateName(games[0]) === 'ResultState', `host 进入结算（${stateName(games[0])}）`);
  const guestsInResult = games.slice(1).filter((g) => stateName(g) === 'ResultState').length;
  ok(guestsInResult === 3, `三个 guest 也收到结算广播（${guestsInResult}/3）`);

  const rows = games[2].states.current.rows;
  ok(rows.length === 4, 'guest 拿到了四行计分板');
  ok(rows[0].score === 820 && rows[0].name === '小雷', `榜首：${rows[0].name} ${rows[0].score}`);
  ok(games[2].states.current.myScore === 155, `guest2 显示自己的分 155（实际 ${games[2].states.current.myScore}）`);
  // 计分板是 host 广播下来的，「（我）」必须按各自座位重算
  const mine = rows.filter((r) => r.you);
  ok(
    mine.length === 1 && mine[0].seat === 2,
    `guest2 的「我」标在自己那行（seat=${mine.map((r) => r.seat).join(',')}）`
  );
  ok(
    games[0].states.current.rows.filter((r) => r.you)[0].seat === 0,
    'host 的「我」标在 seat 0'
  );

  const board = loadBoard();
  ok(board.length === 4, `四个人的成绩都以昵称为主键入了榜（${board.map((r) => r.name + ':' + r.score).join(' ')}）`);
  ok(board[0].name === '小雷' && board[0].score === 820, '榜首是本局第一名');
}

section('8. 全队复活');
{
  // guest2 请求复活 → host 执行 → 广播 REVIVED → 三个 guest 回到战场
  const guestResult = games[2].states.current;
  guestResult.waitingRevive = true;
  guestResult.sync.requestRevive();
  await frames(16);
  ok(stateName(games[0]) === 'FruitVsZombieState', `host 回到战场（${stateName(games[0])}）`);
  const back = games.slice(1).filter((g) => stateName(g) === 'FruitVsZombieState').length;
  ok(back === 3, `三个 guest 都回到战场（${back}/3）`);
  await frames(30);
  ok(
    games[1].states.current.world.bodies.length > 0,
    '复活后 guest 仍在正常接收快照'
  );
}

section('9. 退出对局回到房间');
{
  // 让全队再死一次进结算，然后所有人点退出
  const z = games[0].states.current;
  ok(z.getName() === 'FruitVsZombieState', `host 当前在战场（${z.getName()}）`);
  z.hp = 1;
  const zb = z.world.bodies.find((b) => b.isZombie && !b.dead);
  if (zb) zb.y = z.warnY - zb.r - 1;
  await frames(24);
  ok(games.every((g) => stateName(g) === 'ResultState'), `四端都在结算页（${games.map(stateName).join(' / ')}）`);

  for (const g of games) g.states.current._exit();
  await frames(10);
  ok(games.every((g) => stateName(g) === 'RoomState'), '四端都回到房间界面（连接保持，可再来一局）');
  ok(games.every((g) => !g.net.inMatch), '会话退出 MATCH 阶段');
  ok(games.every((g) => g.net.joined), '房间连接没有断开');
}

section('10. 全程无异常');
{
  const real = errors.filter((e) => !/卡池 id/.test(e));
  ok(real.length === 0, real.length ? `捕获到 ${real.length} 条异常：\n     ${real.slice(0, 5).join('\n     ')}` : '整个流程没有抛出任何异常');
}

console.error = realError;
console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
