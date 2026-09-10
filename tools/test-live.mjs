/**
 * 线上部署冒烟自检
 * ------------------------------------------------------------------
 * 用真浏览器打开**站点上已发布的那个版本**，确认：
 *   · 页面能起来、画布在渲染、没有资源 404 / 未捕获异常；
 *   · 站点的 /static/gamehub-room.js 真的能加载到（联机链路的前提）；
 *   · 未登录时点「联机对战」会给出明确提示而不是卡死或白屏。
 *
 * 站点是登录态才放行的（匿名访问游玩地址会被打回登录页），而浏览器导航没法
 * 自己带 Authorization 头，所以这里用 CDP 给页面挂上 API Token 来模拟登录态。
 * Token 只存在于命令行 / 环境变量，**不会**进包 —— 包里的鉴权始终走同域 Cookie。
 *
 * WebSocket 不吃这个头，所以真正的四人对局不在这里跑，由另外两个自检覆盖：
 *   · tools/test-web.mjs        真浏览器 + 真 SDK + 本地房间服务，跑完整对局；
 *   · tools/probe-live-room.mjs 拿 token 核对线上房间服务的协议字段。
 *
 * 跑法：node tools/test-live.mjs <token> [url]
 */
import path from 'path';
import { Tab, launchBrowser, closeBrowsers, findBrowser, sleep } from './cdp.mjs';

const URL_DEFAULT = 'http://101.43.19.238/g/06817cbb13e4ce23/v/7be2f769f853464c/index.html';
const TOKEN = process.argv[2] || process.env.GH_TOKEN || '';
const PAGE = process.argv[3] || process.env.GH_PLAY_URL || URL_DEFAULT;
const SHOTS = path.resolve('dist');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; failures.push(label); console.log('  FAIL ' + label); }
}
function section(n) { console.log('\n== ' + n + ' =='); }

if (!findBrowser()) {
  console.error('找不到 Edge/Chrome，跳过线上冒烟');
  process.exit(0);
}
if (!TOKEN) {
  console.error('用法：node tools/test-live.mjs <token> [url]');
  process.exit(2);
}

section('线上版本：' + PAGE);
// 先停在空白页，把鉴权头挂好再导航过去（站点匿名访问会被打回登录页）
const br = await launchBrowser('live', 9335, 'about:blank');
ok(!!br, '无头浏览器已启动');
if (!br) process.exit(1);
const T = await Tab.attach('线上', br.port, /about:blank|^$/);
ok(!!T, '接上了浏览器页面');
if (!T) {
  await closeBrowsers();
  process.exit(1);
}
await T.setHeaders({ Authorization: 'Bearer ' + TOKEN });
await T.goto(PAGE);
await sleep(4000);
ok(
  !/\/account|登录/.test(String(await T.eval('document.title')) + String(await T.eval('location.pathname'))),
  `以登录身份打开了游玩地址（title=${await T.eval('document.title')}）`
);

// ---- 页面本体 ----
ok(await T.eval('typeof wx === "object"'), 'wx 垫片已注入');
ok(await T.eval('typeof window.GameHubRoom === "function"'), '站点房间 SDK 已加载（/static/gamehub-room.js）');
const cv = await T.eval(`(() => { const c = document.querySelector('canvas'); return c ? c.width + 'x' + c.height : ''; })()`);
ok(!!cv && !/^0/.test(cv), `画布已创建（${cv}）`);
ok(await T.probe('!!g'), '游戏主循环已启动');
ok((await T.stateName()) === 'LobbyState', '停在大厅');
ok((await T.colors()) > 5, '大厅确实渲染出来了');
ok(!!(await T.probe('g.playerName')), `昵称已就绪（${await T.probe('g.playerName')}）`);
ok(await T.probe('!!g.net'), '网页环境识别为支持联机');

// detectGameId 是从 /g/{game_id}/v/... 里拆出来的，拆错了建房必定 404
const gameId = await T.probe('g.net.gameId');
ok(
  /^[0-9a-f]{8,}$/.test(gameId || '') && PAGE.includes(gameId),
  `从游玩地址里解析出 game_id：${gameId}`
);

// 画面在动 = rAF 链没断
const f1 = await T.probe('g.lastTime');
await sleep(600);
const f2 = await T.probe('g.lastTime');
ok(f2 > f1, '主循环在持续推进（画面没冻住）');
await T.geom();
ok(await T.shot(path.join(SHOTS, 'live-1-lobby.png')), '大厅截图：dist/live-1-lobby.png');

// ---- 联机入口：打在线上真房间服务上 ----
section('联机入口 → 线上房间服务');
await T.tap(375, T.designH * 0.52 + 116 + 46);
await sleep(1000);
ok((await T.stateName()) === 'RoomState', '能进到联机界面');
const settled = await T.waitFor(
  `g.net.connected || (g.states.current.status && !/正在/.test(g.states.current.status))`,
  12000
);
const status = await T.probe('g.states.current.status');
ok(settled, `联机界面给出了明确状态：${status}`);
ok((await T.colors()) > 5, '联机界面渲染正常');
const connected = await T.probe('g.net.connected');
ok(connected, '与线上房间服务的 WebSocket 已连上');

if (connected) {
  // createBtn: y = H*0.28，高 92（roomState.js）
  await T.tap(375, T.designH * 0.28 + 46);
  ok(await T.waitFor('g.net.joined', 10000), '在线上服务真建出了一个房间');
  const code = await T.probe('g.net.code');
  ok(/^[A-Z0-9]{4,8}$/.test(String(code || '')), `拿到线上房间号：${code}`);
  ok((await T.probe('g.net.seat')) === 0, '自己坐 0 号位');
  ok(await T.probe('g.net.isOwner'), '自己是房主（可以开始对局）');
  ok((await T.probe('g.net.roster.length')) === 1, '名册里 1 个人');
  ok(await T.shot(path.join(SHOTS, 'live-2-room.png')), '房间截图：dist/live-2-room.png');
  // 收尾：别在公共服务上留下空房间
  await T.probe('g.net.leave() || true');
  await sleep(500);
  ok(!(await T.probe('g.net.joined')), '已退出房间（不给公共服务留垃圾房）');
} else {
  ok(await T.shot(path.join(SHOTS, 'live-2-room.png')), '房间截图：dist/live-2-room.png');
  ok(
    /登录|连接|失败|断开/.test(String(status || '')),
    '连不上时给出明确提示（不会卡死）'
  );
}

// ---- 报错汇总 ----
section('报错汇总');
ok(
  T.exceptions.length === 0,
  T.exceptions.length
    ? `未捕获异常 ${T.exceptions.length} 条：\n     ${T.exceptions.slice(0, 3).join('\n     ')}`
    : '没有未捕获异常'
);
// COOP 那条是站点自己走 http 时浏览器给的提醒，与游戏包无关
const noisy = T.errors.filter((e) => !/Cross-Origin-Opener-Policy/i.test(e));
ok(
  noisy.length === 0,
  noisy.length
    ? `控制台报错 ${noisy.length} 条：\n     ${noisy.slice(0, 4).join('\n     ')}`
    : '控制台没有报错'
);
if (T.errors.length !== noisy.length) {
  console.log('  （已忽略站点 http 环境下的 COOP 提醒 1 条）');
}

T.close();
await closeBrowsers();

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
