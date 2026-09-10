/**
 * 进度系统的**线上**联调
 * ------------------------------------------------------------------
 *   node tools/test-live-progress.mjs <token>
 *
 * 前面的 test-progress.mjs 用假 SDK 断言映射逻辑；这一个把同一段映射代码
 * （js/net/progress.js 里真正的 reportRun）接到**真站点**上，验证的是别的东西：
 *
 *   游戏写的每一个 API Name，线上是不是都声明过了。
 *
 * 这条最容易翻车 —— 平台对未声明的名字是「整单 400 拒绝」，漏一个统计就等于
 * 一局的所有数据全丢，而且游戏本地看不出任何异常。单测里假 SDK 来者不拒，
 * 只有对着线上打一发才能发现。
 *
 * 测完会把这个账号在这款游戏上的进度清空（ResetAllStats）还原现场。
 */
import { RunStats } from '../js/core/runStats.js';
import { ProgressClient, __setStatsFactory } from '../js/net/progress.js';

const HOST = process.env.GH_HOST || 'http://101.43.19.238';
const GAME_ID = process.env.GH_GAME_ID || '06817cbb13e4ce23';
const token = process.argv[2] || process.env.GH_TOKEN;
if (!token) {
  console.error('用法：node tools/test-live-progress.mjs <token>');
  process.exit(2);
}
const auth = { Authorization: 'Bearer ' + token };

let pass = 0;
const fails = [];
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fails.push(label); console.log(' FAIL  ' + label + (extra ? '   <- ' + extra : '')); }
}
function eq(label, got, want) {
  ok(label, got === want, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
}

const api = (p, init) => fetch(HOST + p, { ...init, headers: { ...auth, ...(init && init.headers) } });
const mine = () => api(`/api/v1/games/${GAME_ID}/stats/me`).then((r) => r.json());

/**
 * 一个「真出网」的 SDK：语义和 /static/gamehub-stats.js 一致（写只改内存，
 * store() 才出网），但鉴权换成 Bearer，好在 node 里跑。
 */
function liveSdk(defs, values) {
  const pending = { set: {}, inc: {}, unlock: [], submit: {} };
  let lastBody = null;
  return {
    lastBody: () => lastBody,
    gh: {
      enabled: true,
      defs,
      values,
      unlocked: {},
      on() {},
      async ready() {},
      get: (id) => (values[id] || 0) + (pending.inc[id] || 0),
      set(id, v) { pending.set[id] = v; },
      inc(id, n) { pending.inc[id] = (pending.inc[id] || 0) + n; },
      unlock(id) { if (!pending.unlock.includes(id)) pending.unlock.push(id); },
      submit(id, score) { pending.submit[id] = { score }; },
      async store() {
        const body = {};
        if (Object.keys(pending.set).length) body.set = { ...pending.set };
        if (Object.keys(pending.inc).length) body.inc = { ...pending.inc };
        if (pending.unlock.length) body.unlock = [...pending.unlock];
        if (Object.keys(pending.submit).length) body.submit = { ...pending.submit };
        lastBody = body;
        const res = await api(`/api/v1/games/${GAME_ID}/stats`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} ${data.error || ''}`);
          err.status = res.status;
          err.payload = data;
          throw err;
        }
        pending.set = {}; pending.inc = {}; pending.unlock = []; pending.submit = {};
        return data;
      },
      async board(id, limit) {
        const r = await api(`/api/v1/games/${GAME_ID}/leaderboards/${id}?limit=${limit || 10}`);
        const d = await r.json();
        return d.leaderboard;
      }
    }
  };
}

console.log('== 1. 线上 Schema ==');
const before = await mine();
ok('拿到线上目录', before.ok === true, JSON.stringify(before).slice(0, 200));
ok('令牌对应的账号已登录', before.logged_in === true);
console.log(`  统计 ${before.stats.length} · 成就 ${before.achievements.length} · 排行榜 ${before.leaderboards.length}`);
// 隐藏成就在玩家视角下会被平台抹掉名字和「已解锁」那张图，只留灰版 —— 这是对的，
// 别把它当成漏传图标。
const visible = before.achievements.filter((a) => !a.hidden);
ok('可见成就的两张图标都在', visible.every((a) => a.icon_unlock && a.icon_locked),
  visible.filter((a) => !a.icon_unlock || !a.icon_locked).map((a) => a.id).join(','));
ok('隐藏成就被平台遮住了（有灰版图、没有名字和亮版图）',
  before.achievements.filter((a) => a.hidden).every((a) => a.icon_locked && !a.icon_unlock),
  JSON.stringify(before.achievements.filter((a) => a.hidden).map((a) => a.id)));

const baseline = {};
for (const s of before.stats) baseline[s.id] = s.value;
ok('测试前该账号没有进度（可以放心写）', before.stats.every((s) => !s.value),
  before.stats.filter((s) => s.value).map((s) => s.id).join(','));

console.log('\n== 2. 把真实的一局战绩打到线上 ==');
const sdk = liveSdk(
  {
    stats: before.stats,
    achievements: before.achievements,
    leaderboards: before.leaderboards
  },
  baseline
);
__setStatsFactory({ connect: () => sdk.gh });
const client = new ProgressClient();
client.gameId = GAME_ID;   // node 里 detectGameId() 拿不到，手动指定
await client.init();
client.gameId = GAME_ID;
ok('客户端就绪', client.enabled);

// 造一局：通关、零掉血、打到了僵尸关
const run = new RunStats();
run.online = true;
run.add(0, 'kills', 120);
run.add(0, 'merges', 35);
run.add(0, 'drops', 90);
run.add(0, 'cards', 7);
run.add(0, 'watermelons', 1);
run.bump(0, 'maxFruitLevel', 10);
run.bumpWave(11);
run.markStage('fruitMerge');
run.markStage('fruitVsZombie');

let res;
let err = null;
try {
  res = await client.reportRun(run.forSeat(0), { score: 12800, win: true, champion: true });
} catch (e) {
  err = e;
}
console.log('  提交的报文：' + JSON.stringify(sdk.lastBody()));
ok('reportRun 没有抛异常', !err, err && err.message);
ok('服务端接受了这一单（没有未声明的 API Name）', !!res && res.ok === true,
  JSON.stringify(res).slice(0, 400));

if (!res || !res.ok) {
  // 这就是这个测试存在的意义：把服务端指出的名字直接打出来
  console.log('\n  !! 服务端拒绝了。它会指出第一个没声明的名字，对照 gamehub.progression.json 补上。');
  console.log('  !! 报文里用到的名字：');
  const b = sdk.lastBody() || {};
  console.log('     set:    ' + Object.keys(b.set || {}).join(', '));
  console.log('     inc:    ' + Object.keys(b.inc || {}).join(', '));
  console.log('     unlock: ' + (b.unlock || []).join(', '));
  console.log('     submit: ' + Object.keys(b.submit || {}).join(', '));
} else {
  console.log('\n== 3. 服务端算出来的结果 ==');
  eq('累计击杀落库', res.stats.zombie_kills, 120);
  eq('累计合成落库', res.stats.merges, 35);
  eq('单局最高分落库', res.stats.best_score, 12800);
  eq('最远波次落库', res.stats.best_wave, 11);
  eq('局数 +1', res.stats.games_played, 1);
  eq('通关 +1', res.stats.stage_clears, 1);
  ok('没有任何一项被跳过', !res.skipped || !res.skipped.length, JSON.stringify(res.skipped));
  ok('没有任何一项被夹紧（max_delta 定得够宽）', !res.clamped || !res.clamped.length,
    JSON.stringify(res.clamped));

  const unlocked = res.unlocked || [];
  console.log('  解锁：' + unlocked.join(', '));
  for (const id of ['first_blood', 'zombie_hunter', 'score_10k', 'wave_veteran', 'the_end_of_road', 'team_champion', 'flawless_stage']) {
    ok(`「${id}」按阈值解锁了`, unlocked.includes(id), JSON.stringify(unlocked));
  }
  ok('还没到 1000 击杀，「尸潮终结者」不该解锁', !unlocked.includes('zombie_slayer'));
  ok('累计合成还不到 100，「合成学徒」不该解锁', !unlocked.includes('merge_apprentice'));

  console.log('\n== 4. 排行榜 ==');
  const boards = res.leaderboards || {};
  console.log('  ' + JSON.stringify(boards));
  for (const id of ['high_score', 'top_kills', 'merge_master', 'deep_run', 'survivor']) {
    ok(`「${id}」收到了成绩`, !!boards[id], JSON.stringify(Object.keys(boards)));
  }
  eq('得分榜的分数正确', boards.high_score && boards.high_score.score, 12800);
  ok('首次提交算 improved', boards.high_score && boards.high_score.improved === true);
  ok('得分榜上有名次', !!(boards.high_score && boards.high_score.rank));

  console.log('\n== 5. 紧接着再打一局：既验限流重试，也验 KeepBest ==');
  // 故意不等 —— 这一发必然撞上 2 秒限流，靠 progress.js 里的自动重试补上。
  // 现实中「一局打完立刻重开、在水果关几秒内被顶出去」就是这个时序。
  const run2 = new RunStats();
  run2.add(0, 'kills', 5);
  run2.markStage('fruitMerge');
  const t0 = Date.now();
  const res2 = await client.reportRun(run2.forSeat(0), { score: 300, win: false });
  ok('撞上限流后自动重试成功了（这一局没白打）', !!res2 && res2.ok === true,
    JSON.stringify(res2).slice(0, 300));
  ok('确实是等满了限流窗口才发出去的', Date.now() - t0 > 900, `只用了 ${Date.now() - t0} 毫秒`);
  if (res2 && res2.ok) {
    eq('最高分没被低分覆盖', res2.stats.best_score, 12800);
    ok('best_score 出现在 skipped 里（increment_only 生效）',
      (res2.skipped || []).some((s) => s.id === 'best_score'), JSON.stringify(res2.skipped));
    eq('累计击杀继续累加', res2.stats.zombie_kills, 125);
    eq('阵亡 +1', res2.stats.deaths, 1);
    ok('得分榜没被低分刷掉',
      res2.leaderboards.high_score && res2.leaderboards.high_score.improved === false,
      JSON.stringify(res2.leaderboards.high_score));
  }

  console.log('\n== 6. 面板取数（打完之后）==');
  await client._pullExtras();
  const after = await mine();
  const kills = after.stats.find((s) => s.id === 'zombie_kills');
  eq('stats/me 里的击杀数对得上', kills && kills.value, 125);
  ok('游玩时长是平台内置的只读统计', typeof after.playtime_seconds === 'number');
  const hunter = after.achievements.find((a) => a.id === 'zombie_hunter');
  ok('僵尸猎人已解锁', hunter && hunter.unlocked === true);
  ok('成就带上了全球完成率', typeof (hunter && hunter.percent) === 'number');
  const board = await client.gh.board('high_score', 10);
  ok('能读回排行榜', !!(board && board.top && board.top.length), JSON.stringify(board).slice(0, 200));
  ok('我在榜上', !!(board && board.me && board.me.rank), JSON.stringify(board && board.me));

  console.log('\n== 7. 限流本身（不走重试，直接打裸接口）==');
  const raw = () => api(`/api/v1/games/${GAME_ID}/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inc: { games_played: 1 } })
  });
  await new Promise((r) => setTimeout(r, 2500));   // 先让窗口过掉，下面两发才有确定的结果
  eq('窗口过后第一发通过', (await raw()).status, 200);
  eq('紧接着第二发被限流', (await raw()).status, 429);
}

console.log('\n== 8. 清场：把这个账号的进度还原 ==');
const reset = await api(`/api/v1/games/${GAME_ID}/stats/reset`, { method: 'POST' });
ok('ResetAllStats 成功', reset.ok, String(reset.status));
const end = await mine();
ok('进度已清空', end.stats.every((s) => !s.value),
  end.stats.filter((s) => s.value).map((s) => s.id + '=' + s.value).join(','));
ok('成就也清了', end.achievements.every((a) => !a.unlocked),
  end.achievements.filter((a) => a.unlocked).map((a) => a.id).join(','));

__setStatsFactory(null);
console.log('\n----------------------------------------------------');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败：' + fails.join('、'));
  process.exit(1);
}
