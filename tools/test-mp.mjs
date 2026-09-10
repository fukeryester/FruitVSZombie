/**
 * 四端联机无头自检
 * ------------------------------------------------------------------
 * 在一个 node 进程里跑起四份完整的联机逻辑（一个 host + 三个 guest），
 * 用进程内的房间服务模拟（tools/mock-hub.mjs）互相收发真实报文，
 * 然后断言这些事：
 *   1. 四个人建房/入座正常，座位 0 是主机；
 *   2. host 的世界能通过快照 + lerp 复现到每个 guest（刚体数量/位置对齐）；
 *   3. guest 的投放请求能被 host 落实成真实水果，且得分归到 guest 自己名下；
 *   4. 选卡是全员暂停 + 5 秒截止 + 未选自动随机，且**四个人选的卡效果全部生效**；
 *   5. 快照不超 8KB、发送不超 20 条/秒；
 *   6. 结算榜以昵称为主键，四个人的真实成绩都能落榜；
 *   7. 复活是全队复活；主机离开会中止本局。
 *
 * 注意：本文件里的 step() 按**真实时间**推进（每帧真的 sleep 一个帧长）。
 * 发送限流与插值取样都读墙上时钟，压缩时间会让整个用例失去意义。
 *
 * 跑法：node tools/test-mp.mjs
 */
import './wx-node-shim.mjs';
import * as hub from './mock-hub.mjs';
import { __setSdkFactory } from '../js/net/roomClient.js';
import { MatchSession } from '../js/net/session.js';
import { CardSystem } from '../js/cards/index.js';
import { registerCard } from '../js/cards/cardSystem.js';
import { Card } from '../js/cards/cardBase.js';
import { submitScores, loadBoard, getRank, clearBoard } from '../js/core/leaderboard.js';
import { MAX_PACKET_BYTES, CARD_PICK_SECONDS, SNAPSHOT_HZ } from '../js/config/net.js';
import { Body, PhysicsWorld } from '../js/core/physics.js';
import { StageSync } from '../js/net/stageSync.js';
import { levels, physicsDefaults } from '../js/config/balls.js';

__setSdkFactory(hub.MockClient);

/**
 * 三张探针卡：onApply 时把「哪张卡 + 归属谁」记到全局数组里。
 * 用它们代替真卡池，就能精确断言「四个人选的四张卡是不是都作用到了
 * 同一个共享世界」，而不用去猜某张真卡的副作用长什么样。
 */
const APPLIED = [];
function makeProbe(tag) {
  return class ProbeCard extends Card {
    constructor() {
      super();
      this.name = '探针' + tag;
      this.desc = '测试用';
      this.icon = tag;
    }
    onApply(ctx) {
      APPLIED.push({ tag, seat: ctx.currentSeat() });
      ctx.addScore(10);
    }
  };
}
registerCard('probe_a', makeProbe('A'));
registerCard('probe_b', makeProbe('B'));
registerCard('probe_c', makeProbe('C'));
const PROBE_POOL = ['probe_a', 'probe_b', 'probe_c'];

// ---------------- 迷你测试框架 ----------------
let pass = 0;
let fail = 0;
const failures = [];

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

function near(a, b, tol, label) {
  ok(Math.abs(a - b) <= tol, `${label} (${Math.round(a)} vs ${Math.round(b)}, tol ${tol})`);
}

function section(name) {
  console.log('\n== ' + name + ' ==');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 一个"够用"的假 game ----------------
function fakeGame(name) {
  return {
    // 与真机一致的设计分辨率（水果半径是按 750 宽调的，用 375 会挤成一团）
    screenW: 750,
    screenH: 1334,
    playerName: name,
    playerLevel: 1,
    bestScore: 0,
    saveBest() {},
    resetPlayerLevel() {},
    audio: { play() {}, startBgm() {}, stopBgm() {} },
    states: { current: null, push() {}, pop() {}, switchTo() {} },
    net: null,
    carrySeatScores: null,
    hasNextStage: () => false,
    createNextStageState: () => null,
    createResultState: () => null,
    createStageState: () => null,
    createLobbyState: () => null,
    createRoomState: () => null,
    payModal: { render() {}, handleTouch: () => false }
  };
}

/**
 * 极简局内 state：只保留 StageSync 真正依赖的那些钩子与字段。
 * 这样测的是**同步层本身**，不会被两个真实关卡的玩法细节干扰。
 */
class MiniStage {
  constructor(game) {
    this.game = game;
    this.floorY = 1280;
    this.dropY = 212;
    this.touchX = 375;
    this.nextLevel = 1;
    this.score = 0;
    this.seatScores = [0, 0, 0, 0];
    this.effects = [];
    this.toasts = [];
    this.dead = false;
    this.world = new PhysicsWorld(
      { left: 0, right: game.screenW, top: 0, bottom: this.floorY },
      () => {}, () => {}, () => {}
    );
    this.current = null;
    this.sync = new StageSync(this, 'mini');
    this.cardSystem = null;
    this.revived = 0;
  }

  attachCards(pool) {
    this.cardSystem = new CardSystem(this.game, {
      getBodies: () => this.world.bodies.slice(),
      removeBody: (b) => this.world.remove(b),
      resizeBody: (b, r) => this.world.resize(b, r),
      addScore: (n) => this._award(n, this.cardSystem.applyingSeat),
      addEffect: (e) => this.effects.push(e),
      toast: (t) => this.toasts.push(t),
      playSound: () => {},
      isFieldCalm: () => true,
      startTimedEffect: () => {},
      forceDrops: (lv, n) => { this.forced = { lv, n }; },
      setBodyCollision: (on) => { this.collision = on; },
      applyRandomForces: () => { this.forcedRandom = (this.forcedRandom || 0) + 1; },
      addSplitCharges: (n) => { this.splitCharges = (this.splitCharges || 0) + n; },
      addShotSlot: () => { this.shotSlots = (this.shotSlots || 1) + 1; },
      freezeZombies: () => { this.frozen = true; },
      // 探针卡用它读「当前结算的是谁选的卡」
      currentSeat: () => this.cardSystem.applyingSeat
    }, pool, this.sync);
    return this.cardSystem;
  }

  _award(n, seat) {
    const s = seat == null || seat < 0 ? this.sync.mySeat : seat;
    this.score += n;
    this.seatScores[s] = (this.seatScores[s] || 0) + n;
  }

  rollLauncherLevel() { return 1; }

  spawnDrop(x, level, seat) {
    const r = levels[level].radius;
    const b = new Body(x, this.dropY, r, level, physicsDefaults);
    b.owner = seat;
    this.world.add(b);
    return b;
  }

  buildArenaDesc() { return { tag: 'mini' }; }
  applyArenaDesc(desc) { this.arena = desc; }
  collectExtra() { return { s: this.score, n: this.world.bodies.length }; }
  applyExtra(x) { this.netExtra = x; }
  afterGuestSync() {}
  onNetToast(t) { this.toasts.push(t); }
  onNetResult(d) { this.result = d; }
  onNetRevived() { this.revived++; }
  revive() { this.revived++; this.dead = false; }
}

// ---------------- 建起四个 peer ----------------
async function makePeers(n, names) {
  const peers = [];
  let code = '';
  for (let i = 0; i < n; i++) {
    const game = fakeGame(names[i]);
    const session = new MatchSession();
    session.gameId = 'testgame';
    session.playerName = names[i];
    game.net = session;
    if (i === 0) {
      code = await session.host();
    } else {
      await session.joinRoom(code);
    }
    peers.push({ game, session, stage: null });
  }
  // 名册与昵称通过 HELLO 报文互认，冲一冲发送队列
  for (let k = 0; k < 6; k++) {
    for (const p of peers) p.session.update();
    await sleep(60);
  }
  return { peers, code };
}

function startMatch(peers) {
  peers[0].session.beginMatchAsHost();
  const hostId = peers[0].session.clientId;
  for (let i = 1; i < peers.length; i++) peers[i].session.beginMatchAsGuest(hostId);
  for (const p of peers) {
    p.stage = new MiniStage(p.game);
    p.stage.sync.onEnter();
  }
}

function pump(peers) {
  for (const p of peers) p.session.update();
}

/** 冲队列：反复 flush + 让时间流动，直到关键报文都投递出去 */
async function settle(peers, ms = 200) {
  const step = 25;
  for (let t = 0; t < ms; t += step) {
    pump(peers);
    await sleep(step);
  }
  pump(peers);
}

/** 让 host 跑 n 帧物理并广播；guest 跟着采样 */
async function step(peers, frames, dt = 1 / 30) {
  for (let f = 0; f < frames; f++) {
    const host = peers[0].stage;
    host.world.step(dt);
    host.sync.hostUpdateLaunchers(dt);
    host.sync.hostTick(dt);
    pump(peers);
    for (let i = 1; i < peers.length; i++) peers[i].stage.sync.guestSync();
    await sleep(Math.round(dt * 1000));
  }
}

// ================= 开跑 =================
const NAMES = ['阿飞', '小雷', '橘子皇', 'Kart4'];

section('1. 建房 / 入座 / 名册');
const { peers, code } = await makePeers(4, NAMES);
ok(!!code, `建房成功，房间号 ${code}`);
ok(peers.every((p) => p.session.joined), '四端都已入座');
ok(peers.map((p) => p.session.seat).join(',') === '0,1,2,3', '座位号依次为 0,1,2,3');
ok(peers[0].session.isOwner && !peers[1].session.isOwner, '座位 0 是房主');
ok(peers[0].session.playerCount === 4, '房主看到 4 个人');
ok(
  peers[1].session.roster.map((m) => m.name).join(',') === NAMES.join(','),
  '昵称通过 HELLO 报文同步到了每个人的名册'
);

section('2. 开局 / 主机判定');
startMatch(peers);
ok(peers[0].stage.sync.isHost && !peers[0].stage.sync.isGuest, 'seat0 是 host');
ok(peers.slice(1).every((p) => p.stage.sync.isGuest), '其余三端是 guest');
ok(peers[0].stage.sync.playerCount === 4, 'host 侧人数为 4');

section('3. 快照 + lerp：host 的世界复现到每个 guest');
for (let i = 0; i < 12; i++) {
  peers[0].stage.spawnDrop(60 + i * 55, 1 + (i % 3), i % 4);
}
await step(peers, 45);

const hostAlive = peers[0].stage.world.bodies.filter((b) => !b.dead);
for (let i = 1; i < 4; i++) {
  const gb = peers[i].stage.world.bodies;
  ok(gb.length === hostAlive.length, `guest${i} 刚体数量与 host 一致（${gb.length}）`);
}
{
  // 位置对齐：guest 渲染的是「现在-140ms」的世界，所以允许一点滞后误差
  const hostById = new Map(hostAlive.map((b) => [b.nid, b]));
  let worst = 0;
  for (const b of peers[2].stage.world.bodies) {
    const h = hostById.get(b.nid);
    if (!h) continue;
    worst = Math.max(worst, Math.hypot(h.x - b.x, h.y - b.y));
  }
  ok(worst < 60, `guest2 位置与 host 的最大偏差 ${worst.toFixed(1)}px（插值滞后范围内）`);
}

section('4. guest 输入 → host 权威投放 + 得分归属');
{
  const before = peers[0].stage.world.bodies.length;
  const g3 = peers[3].stage;
  g3.sync.mine = { level: 2, next: 1, ready: true };
  g3.sync.guestSendInput(1, 640, true);   // 投放请求：右侧空地
  await settle(peers, 150);

  // 只推一帧投射口逻辑，先看落点，避免物理把它挪走后无从判断
  peers[0].stage.sync.hostUpdateLaunchers(1 / 30);
  const spawned = peers[0].stage.world.bodies.length - before;
  ok(spawned === 1, `host 为 guest3 的请求生成了 ${spawned} 颗水果`);
  // 取最新那颗（前面 lerp 用例里也造过 owner=3 的水果）
  const mine = peers[0].stage.world.bodies
    .filter((b) => b.owner === 3)
    .sort((a, b) => b.nid - a.nid);
  ok(mine.length >= 1, 'host 侧这颗水果的 owner 记为座位 3');
  near(mine[0].x, 640, 2, 'host 用了 guest3 上报的横坐标');
  ok(peers[0].stage.sync.remote.get(3).ready === false, 'guest3 的投射口进入冷却');
  await step(peers, 3);
}

section('5. 共享选卡：全员暂停 + 5 秒截止 + 未选随机 + 效果全生效');
{
  for (const p of peers) p.stage.attachCards(PROBE_POOL);
  APPLIED.length = 0;

  const hostCards = peers[0].stage.cardSystem;
  hostCards.trigger();
  hostCards.update();          // 摇三张 + 广播 CARD_OPEN
  await settle(peers, 250);

  ok(hostCards.active, 'host 弹出了选卡浮层（物理暂停）');
  const guestsOpen = peers.slice(1).filter((p) => p.stage.cardSystem.active).length;
  ok(guestsOpen === 3, `三个 guest 同时弹出了浮层（${guestsOpen}/3）`);
  const ids = hostCards.vote ? hostCards.vote.ids : [];
  ok(
    peers.slice(1).every((p) => p.stage.cardSystem.vote &&
      p.stage.cardSystem.vote.ids.join(',') === ids.join(',')),
    '四端看到的是同样的三张候选'
  );
  near(
    (hostCards.vote.deadline - Date.now()) / 1000, CARD_PICK_SECONDS, 1.2,
    '截止时间是 5 秒后'
  );

  // 每个人都能看到三张牌
  ok(
    peers.every((p) => p.stage.cardSystem.overlay.cards.length === 3),
    '四端浮层里都实例化出了三张牌'
  );

  // seat0 / seat1 / seat2 各选一张（故意选不同的三张）；seat3 不选，等超时代选
  const pickOf = (p, idx) => {
    const cs = p.stage.cardSystem;
    cs._onLocalPick(cs.overlay.cards[idx]);
  };
  pickOf(peers[0], 0);
  pickOf(peers[1], 1);
  pickOf(peers[2], 2);
  await settle(peers, 300);
  hostCards.tick(0.016);
  ok(hostCards.vote && hostCards.vote.picks.size === 3, 'host 收齐了三个人的选择，仍在等第四个人');
  ok(hostCards.active, '还没到点，游戏保持暂停');
  ok(APPLIED.length === 0, '收口之前一张卡都还没生效');
  const g1Picked = peers[1].stage.cardSystem.overlay.locked;
  ok(g1Picked, 'guest1 选完后浮层转为锁定态（等其他玩家）');

  // 把截止时间拨到过去，模拟 5 秒到点
  hostCards.vote.deadline = Date.now() - 1;
  hostCards.tick(0.016);
  await settle(peers, 300);

  ok(!hostCards.active && !hostCards.vote, 'host 收口，浮层关闭、游戏恢复');
  const guestsClosed = peers.slice(1).filter((p) => !p.stage.cardSystem.active).length;
  ok(guestsClosed === 3, `三个 guest 的浮层也都关了（${guestsClosed}/3）`);

  // ---- 核心断言：四个人的卡效果全部作用在 host 这一个共享世界上 ----
  ok(APPLIED.length === 4, `host 依次应用了 4 张卡（实际 ${APPLIED.length}）`);
  const seatsApplied = APPLIED.map((a) => a.seat).sort().join(',');
  ok(seatsApplied === '0,1,2,3', `四个座位各贡献一张（归属：${seatsApplied}）`);
  const tags = APPLIED.map((a) => a.tag).sort().join('');
  ok(/A/.test(tags) && /B/.test(tags) && /C/.test(tags), `三张不同的候选都被选中并生效（${tags}）`);
  ok(
    peers[0].stage.seatScores.every((v, i) => i > 3 || v >= 10),
    `卡牌加分按选牌人归属：${peers[0].stage.seatScores.join('/')}`
  );
  ok(
    peers.slice(1).every((p) => p.stage.seatScores.every((v) => v === 0)),
    'guest 不重复执行效果（本地分数没有被自己加一遍）'
  );

  // 汇总提示是随快照捎带给 guest 的，跑几帧让它到位
  await step(peers, 8);
  const announced = peers.slice(1).map((p) => p.stage.toasts.join(' | ')).join(' | ');
  ok(/随机/.test(announced), `第四个人被自动随机代选（提示：${announced.slice(0, 100)}）`);
  ok(NAMES.every((n) => announced.includes(n)), '汇总提示里列出了四个人各自选到的卡');
  ok(
    peers.slice(1).every((p) => p.stage.seatScores.join(',') === peers[0].stage.seatScores.join(',')),
    '卡牌结算后各座位得分同步到了每个 guest'
  );
}

section('6. 平台限制：8KB 单包 + 20 条/秒');
{
  // 塞满一屏（含僵尸上限那种量级），看快照会不会破 8KB
  const host = peers[0].stage;
  for (let i = 0; i < 140; i++) {
    const b = host.spawnDrop(10 + (i * 17) % 360, i % 5, i % 4);
    b.isZombie = i % 2 === 0;
  }
  await step(peers, 15);
  const stats = peers[0].session.client.room.stats;
  ok(stats.maxBytes <= 8192, `最大单包 ${stats.maxBytes} 字节 ≤ 8192`);
  ok(stats.maxBytes <= MAX_PACKET_BYTES + 64, `最大单包在自设安全线 ${MAX_PACKET_BYTES} 之内`);
  ok(stats.errors === 0, `${stats.sent} 条消息全部被服务端接受（无超频/超大拒绝）`);
  const guestBodies = peers[1].stage.world.bodies.length;
  ok(guestBodies > 100, `重载下 guest 仍能收到 ${guestBodies} 个刚体（超限时才会丢最小的那些）`);
}

section('7. 复活：guest 请求 → host 执行 → 广播回全队');
{
  peers[0].stage.dead = true;
  peers[2].stage.sync.requestRevive();
  await settle(peers, 250);
  ok(peers[0].stage.revived === 1, 'host 执行了一次复活');
  ok(!peers[0].stage.dead, 'host 侧死亡标记已清除');
  const back = peers.slice(1).filter((p) => p.stage.revived === 1).length;
  ok(back === 3, `三个 guest 都收到了 REVIVED 回到战场（${back}/3）`);
}

section('8. 结算广播 + 昵称主键排行榜');
{
  clearBoard();
  const rows = peers[0].stage.sync.scoreRows([120, 480, 260, 75]);
  ok(rows.length === 4, '计分板有四行');
  ok(rows[0].score === 480 && rows[0].name === '小雷', '按分数降序，榜首是小雷 480');
  ok(rows.some((r) => r.host), '主机那一行带 host 标记');

  peers[0].stage.sync.announceResult({ win: false }, rows);
  await settle(peers, 250);
  const got = peers.slice(1).filter((p) => p.stage.result && p.stage.result.rows.length === 4).length;
  ok(got === 3, `三个 guest 都收到了结算与计分板（${got}/3）`);

  submitScores(rows.map((r) => ({ name: r.name, score: r.score })));
  const board = loadBoard();
  ok(board.length === 4, '四个人的真实成绩都进了榜单');
  ok(board[0].name === '小雷' && board[0].score === 480, '榜首是小雷 480');
  ok(getRank('小雷').myRank === 1, '按昵称查名次：小雷第 1');
  ok(getRank('Kart4').myRank === 4, '按昵称查名次：Kart4 第 4');

  // 同名只留最高分、局数累加 —— 昵称是主键
  submitScores([{ name: '小雷', score: 300 }]);
  const again = loadBoard().find((r) => r.name === '小雷');
  ok(again.score === 480, '同名再交低分不覆盖历史最高分');
  ok(again.plays === 2, '同名累计游玩局数 → 2');
  ok(loadBoard().length === 4, '同名不产生重复行（主键生效）');
}

section('9. 掉线与退出');
{
  peers[3].session.leave();
  await settle(peers, 150);
  ok(peers[0].session.playerCount === 3, '有人退出后房主看到 3 个人');
  ok(!peers[0].stage.sync.remote.has(3), 'host 清掉了座位 3 的投射口');

  peers[0].session.leave();
  await settle(peers, 150);
  ok(peers[1].session.phase !== 'match', '主机离开后其余人退出对局阶段（本局中止）');
  ok(peers[1].session.lastError.includes('房主'), `其余人收到中止原因：${peers[1].session.lastError}`);
}

// ---------------- 汇总 ----------------
console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  · ' + f);
}
console.log(`快照频率 ${SNAPSHOT_HZ}Hz，选卡截止 ${CARD_PICK_SECONDS}s`);
process.exit(fail ? 1 : 0);
