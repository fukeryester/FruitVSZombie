/**
 * 网页版浏览器端端到端自检
 * ------------------------------------------------------------------
 * 前两个自检跑在 node 里，验的是逻辑；这一个把**打好的包**用本地静态服务
 * 托起来（外加一个最小的房间服务），交给**真正的 Edge**（headless）开
 * 两个标签页，走真实的 /static/gamehub-room.js SDK 建房 + 加入，
 * 通过 CDP 收集控制台报错与未捕获异常，并截图留证。
 *
 * 它专门抓 node 里抓不到的东西：
 *   · web/index.html 与 web/wx-shim.js 的衔接问题；
 *   · 浏览器原生 ESM 的路径 / 后缀问题（小游戏允许省略后缀，浏览器不允许）；
 *   · 真 SDK 的 WebSocket 协议对接（node 侧用的是模拟 SDK）；
 *   · Canvas / Audio / localStorage 在真实浏览器里的差异。
 *
 * 跑法：node tools/test-web.mjs
 * 依赖：Windows 自带 Edge + Node 22+ 内置 WebSocket 客户端。
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { attachRoomService } from './ws-room-server.mjs';
import { Tab, launchBrowser, closeBrowsers, findBrowser, sleep } from './cdp.mjs';

const ROOT = path.resolve('_webtest');
const ZIP = path.resolve('dist/fvz-mp.zip');
const PORT = 8791;
const GAME_ID = 'abcdef0123456789';     // 本地假 game_id（detectGameId 支持 ?game_id= 覆盖）
const PAGE = `http://127.0.0.1:${PORT}/index.html?game_id=${GAME_ID}`;
const SHOTS = path.resolve('dist');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; failures.push(label); console.log('  FAIL ' + label); }
}
function section(n) { console.log('\n== ' + n + ' =='); }
/** 截图 + 断言"图里确实有东西" */
async function shot(tab, name, label) {
  const file = path.join(SHOTS, name);
  ok(await tab.shot(file), `${label}截图：${path.relative(process.cwd(), file)}`);
}
async function cleanup(code) {
  try { server.close(); } catch (e) { /* ignore */ }
  await closeBrowsers();
  process.exit(code);
}

// ---------------- 准备静态站 + 房间服务 ----------------
section('0. 打包产物与本地服务');
if (!fs.existsSync(ZIP)) {
  console.error('先跑 node tools/build-web.mjs 生成 dist/fvz-mp.zip');
  process.exit(1);
}
fs.rmSync(ROOT, { recursive: true, force: true });
await new Promise((resolve, reject) => {
  const p = spawn('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -Path '${ZIP}' -DestinationPath '${ROOT}' -Force`
  ], { stdio: 'ignore' });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('解包失败'))));
});
ok(fs.existsSync(path.join(ROOT, 'index.html')), '压缩包解出了 index.html');
ok(fs.existsSync(path.join(ROOT, 'js', 'net', 'stageSync.js')), '压缩包里带着联机层');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

const served = new Set();
const missed = new Set();
let roomSvc = null;
const server = http.createServer((req, res) => {
  if (roomSvc && roomSvc.handleRest(req, res)) return;   // 建房 / 列房
  let rel = decodeURIComponent(req.url.split('?')[0]);
  // 站点上两个 SDK 都挂在 /static/ 下，本地用包内副本顶上
  if (rel === '/static/gamehub-room.js') rel = '/gamehub-room.js';
  if (rel === '/static/gamehub-stats.js') rel = '/gamehub-stats.js';
  // 进度系统的目录接口：假装成「未登录」，正好把「未登录时写操作空转」这条
  // 分支在真浏览器里跑一遍 —— 没登录的玩家进来就是这个样子。
  if (/^\/api\/v1\/games\/[^/]+\/stats\/me$/.test(rel)) {
    served.add('/api/v1/.../stats/me');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, logged_in: false, player_count: 0, playtime_seconds: null,
      stats: [{ id: 'zombie_kills', display_name: '击杀僵尸数', type: 'int', default: 0, hidden: false, value: 0 }],
      achievements: [{ id: 'first_blood', name: '初次上路', description: '完成第一局游戏', hidden: false, bind_stat: 'games_played', unlock_at: 1, unlocked: false, progress: null, unlocks: 0, percent: 0 }],
      leaderboards: [{ id: 'high_score', name: '最高得分', sort: 'desc', keep: 'best', display: 'number', top: [], me: null }]
    }));
    return;
  }
  // 排行榜接口：给几行假数据，好让「面板画榜」这条渲染分支真的跑起来
  const boardHit = /^\/api\/v1\/games\/[^/]+\/leaderboards\/([^/]+)$/.exec(rel);
  if (boardHit) {
    served.add('/api/v1/.../leaderboards/*');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      leaderboard: {
        id: boardHit[1], name: '最高得分', sort: 'desc', keep: 'best', display: 'number',
        top: [
          { user_id: 1, nickname: '小飞', score: 9200, rank: 1 },
          { user_id: 2, nickname: '橘子皮', score: 4100, rank: 2 },
          { user_id: 3, nickname: '一个名字特别特别特别长的玩家', score: 880, rank: 3 }
        ],
        me: { score: 880, rank: 3 }
      }
    }));
    return;
  }
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    missed.add(rel);
    res.writeHead(404).end('nope');
    return;
  }
  served.add(rel);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
roomSvc = attachRoomService(server);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
ok(true, `本地站点已就绪：${PAGE}`);

if (!findBrowser()) {
  console.error('找不到 Edge/Chrome，跳过浏览器自检');
  server.close();
  process.exit(0);
}

// ---------------- 页面基础自检 ----------------
section('1. 页面外壳与本体');
const brA = await launchBrowser('a', 9333, PAGE);
ok(!!brA, '房主端浏览器已启动');
if (!brA) cleanup(1);
const A = await Tab.attach('A', brA.port);
ok(!!A, '接上了房主端页面');
if (!A) cleanup(1);

// 昵称写死，后面好断言房间名册
ok(await A.setName('主机阿飞'), '预置昵称并重载完成');

ok(await A.eval('typeof wx === "object"'), 'wx 垫片已注入');
ok(await A.eval('typeof window.GameHubRoom === "function"'), '站点房间 SDK 已加载');
const cv = await A.eval(`(() => { const c = document.querySelector('#stage canvas'); return c ? c.width + 'x' + c.height : ''; })()`);
ok(!!cv && !/^0/.test(cv), `画布已创建（${cv}）`);
ok(await A.eval('!!document.getElementById("prompt-input")'), '昵称输入浮层就位');
ok((await A.colors()) > 5, '大厅确实渲染出来了');
ok(
  await A.eval(`(() => { wx.setStorageSync('__p', 'x'); return wx.getStorageSync('__p') === 'x'; })()`),
  'localStorage 读写正常（昵称 / 排行榜可落盘）'
);
ok((await A.probe('g.playerName')) === '主机阿飞', '昵称已从存储读回并注入');
ok((await A.stateName()) === 'LobbyState', '当前处于大厅');
ok(await A.probe('!!g.net'), '联机会话已创建（本环境支持联机）');
await A.geom();
await shot(A, 'web-1-lobby.png', '大厅');

// ---------------- 数据档案 ----------------
section('1b. 进度系统（统计 / 成就 / 排行榜面板）');
ok(await A.eval('typeof window.GameHubStats === "function"'), '统计 SDK 已加载（包内副本兜底）');
ok(await A.waitFor('g.progress.ready'), '进度系统已就绪');
ok(!(await A.probe('g.progress.loggedIn')), '本地harness 未登录，loggedIn 为 false');
ok(!(await A.probe('g.progress.enabled')), '未登录时写入面关闭（不会误报数据）');
ok((await A.probe('g.progress.statRows().length')) > 0, '仍能读到统计目录（目录是公开的）');
ok((await A.probe('g.progress.achievementRows().length')) > 0, '仍能读到成就目录');

// 大厅「数据档案」：x 居中偏左，y = screenH*0.52 + 224，高 68（lobbyState.js）
const statsBtnY = A.designH * 0.52 + 224 + 34;
await A.tap(375 - 80, statsBtnY);
await sleep(500);
ok((await A.stateName()) === 'StatsState', '进入数据档案面板');
ok((await A.colors()) > 5, '面板渲染出来了');
await shot(A, 'web-1b-stats.png', '数据档案·统计页');

// 三个页签都点一遍，确认渲染分支都不炸
for (const [i, want] of [[1, 'achievements'], [2, 'boards'], [0, 'stats']]) {
  const tabW = Math.floor((750 - 80) / 3);
  await A.tap(40 + i * tabW + tabW / 2, A.designH * 0.17 + 34);
  await sleep(350);
  ok((await A.probe('g.states.current.tab')) === want, `切到「${want}」页签`);
  if (want === 'achievements') await shot(A, 'web-1c-achievements.png', '数据档案·成就页');
  if (want === 'boards') {
    ok(await A.waitFor('!!(g.progress.board("high_score") || {}).top', 4000), '排行榜数据已拉回并缓存');
    ok(
      (await A.probe('g.progress.board("high_score").top.length')) === 3,
      '榜上三行（含一个超长昵称，验证截断不压到分数上）'
    );
    await shot(A, 'web-1d-boards.png', '数据档案·排行榜页');
  }
}
ok((await A.stateName()) === 'StatsState', '来回切页签后面板仍然活着（没被异常打回大厅）');

// 返回大厅
await A.tap(375, A.designH - 130 + 44);
await sleep(500);
ok((await A.stateName()) === 'LobbyState', '返回大厅');

// ---------------- 建房 ----------------
section('2. 真 SDK 建房（大厅 → 联机界面 → 创建房间）');
// 大厅「联机对战」：x 居中，y = screenH*0.52 + 116，高 92（lobbyState.js）
await A.tap(375, A.designH * 0.52 + 116 + 46);
await sleep(600);
ok((await A.stateName()) === 'RoomState', '进入联机界面');
ok(await A.waitFor('g.net.connected'), 'WebSocket 已连上本地房间服务（真 SDK 链路）');

// roomState.js 的按钮布局：createBtn y=H*0.28 h=92 / joinBtn +108 / refreshBtn +216
const roomBtnY = (H, off, h) => H * 0.28 + off + h / 2;
await A.tap(375, roomBtnY(A.designH, 0, 92));            // 创建房间
ok(await A.waitFor('g.net.joined'), '房主已建房并入座');

const rooms = [...roomSvc.rooms.values()];
ok(rooms.length === 1, `服务端上有 1 个房间（${rooms.map((r) => r.code).join(',')}）`);
const room = rooms[0];
ok(!!room && room.maxPlayers === 4, `房间人数上限 4（实际 ${room && room.maxPlayers}）`);
ok(!!room && room.members.length === 1, '房间里 1 人');
ok((await A.probe('g.net.code')) === (room && room.code), `客户端房间号与服务端一致（${room && room.code}）`);
ok(await A.probe('g.net.isOwner'), '房主标记正确');
await shot(A, 'web-2-room-host.png', '房主建房后');

// ---------------- 第二个人加入 ----------------
section('3. 第二位玩家从房间列表加入');
const brB = await launchBrowser('b', 9334, PAGE);
ok(!!brB, '客机端浏览器已启动');
if (!brB) cleanup(1);
const B = await Tab.attach('B', brB.port);
ok(!!B, '接上了客机端页面');
if (!B) cleanup(1);
ok(await B.setName('客机小雷'), 'B 端预置昵称完成');
await B.geom();
ok((await B.stateName()) === 'LobbyState', 'B 端大厅就绪');

await B.tap(375, B.designH * 0.52 + 116 + 46);           // 联机对战
await sleep(600);
ok(await B.waitFor('g.net.connected'), 'B 端已连上房间服务');
await B.tap(375, roomBtnY(B.designH, 216, 76));          // 刷新房间列表
ok(await B.waitFor('g.states.current.rooms.length > 0'), 'B 端拉到了房间列表');
ok(
  (await B.probe('g.states.current.rooms[0].code')) === room.code,
  '列表里就是房主开的那间'
);
await shot(B, 'web-3-room-list.png', 'B 端房间列表');

// 列表项：y0 = H*0.28 + 316，行高 82，按钮高 72
await B.tap(375, B.designH * 0.28 + 316 + 36);
ok(await B.waitFor('g.net.joined'), 'B 端已加入房间');

ok(room.members.length === 2, `房间里现在 ${room.members.length} 人`);
ok(room.members.map((m) => m.seat).join(',') === '0,1', '座位号依次为 0,1');
ok((await B.probe('g.net.seat')) === 1, 'B 端座位号为 1');
ok(!(await B.probe('g.net.isOwner')), 'B 端不是房主');
// 昵称靠 HELLO 报文互换，这是「自定义报文真的跨标签页送达」的最短验证
ok(
  await A.waitFor(`g.net.roster.map((m) => m.name).join(',') === '主机阿飞,客机小雷'`),
  'A 端名册收到了 B 的昵称'
);
ok(
  await B.waitFor(`g.net.roster.map((m) => m.name).join(',') === '主机阿飞,客机小雷'`),
  'B 端名册收到了 A 的昵称'
);
await shot(A, 'web-4-room-2players.png', '房主视角（2 人）');
await shot(B, 'web-5-room-guest.png', '客机视角');

// ---------------- 开局 ----------------
section('4. 房主开局 → 两端同时进入战场');
await A.tap(375, A.designH * 0.68 + 50);                 // 开始游戏
ok(await A.waitFor(`g.states.current.constructor.name === 'FruitMergeState'`), 'A 端进入第一阶段');
ok(
  await B.waitFor(`g.states.current.constructor.name === 'FruitMergeState'`),
  'B 端收到 STAGE 报文自动跟进（跨端切场景）'
);
ok(await A.probe('g.net.isHost'), 'A 端是本局主机');
ok(!(await B.probe('g.net.isHost')), 'B 端是客机');
ok((await A.probe('g.net.playerCount')) === 2, '按 2 人缩放局内参数');
ok(
  (await A.probe('g.states.current.goal')) === (await B.probe('g.states.current.goal')),
  '两端的阶段目标分一致'
);
await shot(A, 'web-6-match-host.png', '房主战场');
await shot(B, 'web-7-match-guest.png', '客机战场');

// 两端各投几下：A 是主机（本地直接生成），B 是客机（要把输入上报给 A）
const diag = (tab) => tab.probe(`(() => {
  const s = g.states.current;
  return [
    'bodies=' + s.world.bodies.length,
    'current=' + (s.current ? s.current.level : 'null'),
    'delay=' + (s.spawnDelay || 0).toFixed(2),
    'card=' + !!s.cardSystem.active,
    'guest=' + s.sync.isGuest,
    'score=' + s.score
  ].join(' ');
})()`);
// 主机侧记下每一次真实生成 —— 合成会不断吃掉水果，只看"场上还剩谁的"会飘
await A.probe(`(() => {
  const s = g.states.current;
  s.__spawned = [];
  const f = s.spawnDrop.bind(s);
  s.spawnDrop = (x, level, seat) => { s.__spawned.push(seat); return f(x, level, seat); };
  return true;
})()`);
for (let i = 0; i < 6; i++) {
  await A.tap(220 + i * 50, 900);
  await B.tap(520 - i * 50, 900);
  await sleep(500);
}
await sleep(1500);
console.log('  A: ' + (await diag(A)));
console.log('  B: ' + (await diag(B)));
const hostBodies = await A.probe('g.states.current.world.bodies.length');
ok(hostBodies >= 2, `主机场上有 ${hostBodies} 个水果（合成会吃掉一部分）`);
// 两边的投放都被主机落实了 —— 客机那几下是经 INPUT 报文上报后由主机代生成的
const spawned = await A.probe('g.states.current.__spawned.join(",")');
const seats = new Set(spawned.split(',').filter((s) => s !== ''));
ok(
  seats.has('0') && seats.has('1'),
  `主机生成过两个座位的水果（座位序列 ${spawned}）`
);
// 状态同步的核心指标：客机的世界与主机一致（差 1 个算插值在途）
const guestBodies = await B.probe('g.states.current.world.bodies.length');
ok(
  Math.abs(guestBodies - hostBodies) <= 1,
  `客机重建出 ${guestBodies} 个水果，与主机的 ${hostBodies} 个一致`
);
const hostScore = await A.probe('g.states.current.score');
const guestScore = await B.probe('g.states.current.score');
ok(hostScore > 0, `主机已经算出分数（${hostScore}）—— 说明确实发生了合成`);
ok(guestScore === hostScore, `客机分数与主机一致（${guestScore}）`);
ok(
  await B.probe('g.states.current.sync.remoteViews().length >= 1'),
  '客机能看到房主的投射口'
);
ok(
  await A.probe('g.states.current.sync.remoteViews().length >= 1'),
  '房主能看到客机的投射口'
);
await shot(A, 'web-8-match-host-drops.png', '房主投放后');
await shot(B, 'web-9-match-guest-drops.png', '客机投放后');

// ---------------- 共享选卡 ----------------
section('5. 共享选卡：全员暂停 · 5 秒收口 · 未选自动随机 · 效果共享');
// 两端都把「宣布结果」挂上探针，好观察最终的选卡结果行 [座位, 卡id, 是否随机]
const spy = (tab) => tab.probe(`(() => {
  const cs = g.states.current.cardSystem;
  cs.__rows = null;
  cs.__applied = [];
  const ann = cs._announce.bind(cs);
  cs._announce = (rows) => { cs.__rows = rows; return ann(rows); };
  const one = cs._applyOne.bind(cs);
  cs._applyOne = (id, seat) => { cs.__applied.push(seat + ':' + id); return one(id, seat); };
  return true;
})()`);
await spy(A);
await spy(B);

/**
 * 三张牌的位置（cardOverlay.js）：cardW = min(230, (750-90)/3-10) = 210，gap 18，
 * 竖直居中且高 340 → 中间那张的中心正好落在 x=375。
 */
const cardAt = (tab, i) => [42 + i * 228 + 105, tab.designH / 2];
/** 牌面之外的空白处（用来验证"暂停期间点了也没反应"，别误点到牌上） */
const blankAt = (tab) => [375, tab.designH - 90];

/** 正常要合成 10 次才触发一次三选一，这里直接给主机的选卡队列塞一次 */
async function openVote() {
  await A.probe(`(() => {
    g.states.current.cardSystem.__rows = null;
    g.states.current.cardSystem.__applied = [];
    g.states.current.cardSystem.trigger();
    return true;
  })()`);
  await B.probe('(g.states.current.cardSystem.__rows = null) || true');
  const a = await A.waitFor('g.states.current.cardSystem.overlay.visible');
  const b = await B.waitFor('g.states.current.cardSystem.overlay.visible');
  return a && b;
}

// ---- 第一次投票：客机自己选，主机故意不选，等 5 秒到点被代选 ----
ok(await openVote(), '两端同时弹出三选一（主机开牌 → CARD_OPEN → 客机跟上）');
const idsA = await A.probe('g.states.current.cardSystem.overlay.cards.map((c) => c.cardId).join(",")');
const idsB = await B.probe('g.states.current.cardSystem.overlay.cards.map((c) => c.cardId).join(",")');
ok(!!idsA && idsA === idsB, `两端候选卡完全相同（${idsA}）`);
ok(await A.probe('g.states.current.cardSystem.active'), '主机已暂停');
ok(await B.probe('g.states.current.cardSystem.active'), '客机已暂停');
await shot(A, 'web-10-card-vote.png', '选卡浮层');

await B.tap(...cardAt(B, 2));                       // 客机点第三张
ok(
  await A.waitFor('g.states.current.cardSystem.vote.picks.has(1)', 3000),
  '主机收到客机的选择（CARD_PICK 上行）'
);
ok(
  await B.probe('g.states.current.cardSystem.overlay.locked'),
  '客机选完转入锁定态，继续等其他人'
);
const guestPick = await B.probe('g.states.current.cardSystem.overlay.myPickCard.cardId');
ok(!!guestPick, `客机选的是 ${guestPick}`);
await shot(B, 'web-10b-card-locked.png', '客机选完等其他人');
ok(!(await A.probe('g.states.current.cardSystem.vote.picks.has(0)')), '主机此刻还没选');
ok(await A.waitFor('!!g.states.current.cardSystem.__rows', 9000), '5 秒到点，主机收口');
ok(await B.waitFor('!!g.states.current.cardSystem.__rows', 4000), '客机收到 CARD_DONE');

const rowsA = await A.probe('JSON.stringify(g.states.current.cardSystem.__rows)');
const rowsB = await B.probe('JSON.stringify(g.states.current.cardSystem.__rows)');
ok(rowsA === rowsB, `两端拿到同一份结果 ${rowsA}`);
const rows = JSON.parse(rowsA || '[]');
ok(rows.length === 2, `2 名玩家各出 1 张（共 ${rows.length} 张）`);
ok(rows.some((r) => r[0] === 0 && r[2] === 1), '主机没选 → 自动随机代选（auto=1）');
ok(
  rows.some((r) => r[0] === 1 && r[1] === guestPick && r[2] === 0),
  '客机那张是他自己点的（auto=0）'
);
const applied = await A.probe('g.states.current.cardSystem.__applied.join(",")');
ok(
  applied.split(',').filter(Boolean).length === 2,
  `两张卡的效果都作用在同一个世界上（${applied}）—— 卡牌效果共享`
);
ok(!(await A.probe('g.states.current.cardSystem.active')), '主机恢复运行');
ok(!(await B.probe('g.states.current.cardSystem.active')), '客机恢复运行');
await shot(A, 'web-11-card-applied.png', '选卡结束（效果已共享）');

// ---- 第二次投票：验证「暂停真的停住了」＋「全员选定立刻收口」 ----
await sleep(800);
ok(await openVote(), '再开一次投票');
const nBefore = await A.probe('g.states.current.world.bodies.length');
const posBefore = await A.probe('g.states.current.world.bodies.map((b) => b.x.toFixed(2)).join(",")');
await A.tap(...blankAt(A));                         // 牌面之外，等价于"想投放"
await sleep(1200);
ok(
  (await A.probe('g.states.current.world.bodies.length')) === nBefore,
  '暂停期间投放不生效（水果数量没变）'
);
ok(
  (await A.probe('g.states.current.world.bodies.map((b) => b.x.toFixed(2)).join(",")')) === posBefore,
  '暂停期间物理确实停住了（水果没有位移）'
);

const t0 = Date.now();
await B.tap(...cardAt(B, 0));
await A.tap(...cardAt(A, 1));
ok(await A.waitFor('!!g.states.current.cardSystem.__rows', 4000), '全员选定后立刻收口，没等满 5 秒');
const spent = Date.now() - t0;
ok(spent < 5000, `本次只用了 ${(spent / 1000).toFixed(1)} 秒（早于 5 秒上限）`);
const rows2 = JSON.parse((await A.probe('JSON.stringify(g.states.current.cardSystem.__rows)')) || '[]');
ok(
  rows2.length === 2 && rows2.every((r) => r[2] === 0),
  '两张都是玩家自己点的（没有触发随机代选）'
);
ok(
  rows2[0][1] !== rows2[1][1],
  `两人选的是不同的卡（${rows2.map((r) => r[1]).join(' / ')}）`
);
ok(await B.waitFor('!!g.states.current.cardSystem.__rows', 3000), '客机同样收到本次结果');
ok(!(await A.probe('g.states.current.cardSystem.active')), '两端恢复运行');

// ---------------- 报错汇总 ----------------
section('6. 资源与报错');
const realMissed = [...missed].filter((u) => !/favicon|\.map$/.test(u));
ok(realMissed.length === 0, realMissed.length ? `资源 404：${realMissed.slice(0, 8).join(', ')}` : '没有资源 404');
for (const tab of [A, B]) {
  ok(
    tab.exceptions.length === 0,
    tab.exceptions.length
      ? `${tab.name} 端未捕获异常 ${tab.exceptions.length} 条：\n     ${tab.exceptions.slice(0, 3).join('\n     ')}`
      : `${tab.name} 端没有未捕获异常`
  );
  ok(
    tab.errors.length === 0,
    tab.errors.length
      ? `${tab.name} 端控制台报错 ${tab.errors.length} 条：\n     ${tab.errors.slice(0, 4).join('\n     ')}`
      : `${tab.name} 端控制台没有报错`
  );
}
console.log(`  （共加载 ${served.size} 个资源）`);

A.close();
B.close();
server.close();
await closeBrowsers();

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
