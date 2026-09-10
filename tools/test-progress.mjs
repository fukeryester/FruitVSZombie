/**
 * 进度系统上报的无头测试
 * ------------------------------------------------------------------
 *   node tools/test-progress.mjs
 *
 * 断言的是「游戏 → 平台」这一段映射，不连真站点：把 GameHubStats 换成一个
 * 记录调用的假 SDK，然后检查
 *   · RunStats 的分桶 / 编解码（host 广播给 guest 的那条通道）；
 *   · reportRun 把一局战绩翻译成了正确的 inc / set / unlock / submit；
 *   · 累计类走 inc、最好成绩类走 set（依赖服务端 increment_only 取 max）；
 *   · 未登录时全部空转，不炸；
 *   · 成就 / 排行榜面板的取数。
 */
import { RunStats, recordMerge } from '../js/core/runStats.js';
import { ProgressClient, __setStatsFactory } from '../js/net/progress.js';
import { levels } from '../js/config/balls.js';

let pass = 0;
const fails = [];

function ok(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fails.push(label);
    console.log(' FAIL  ' + label + (extra ? '   <- ' + extra : ''));
  }
}

function eq(label, got, want) {
  ok(label, got === want, `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);
}

/** 记录所有调用的假 SDK，enabled 可控 */
function fakeSdk(enabled = true) {
  const calls = { inc: {}, set: {}, unlock: [], submit: {}, stores: 0 };
  const values = {};
  const gh = {
    enabled,
    defs: {
      stats: [
        { id: 'zombie_kills', display_name: '击杀僵尸数' },
        { id: 'merges', display_name: '触发合成次数' },
        { id: 'runs_reached_zombie', display_name: '打到僵尸关', hidden: true }
      ],
      achievements: [
        { id: 'zombie_hunter', name: '僵尸猎人', description: '杀 100', bind_stat: 'zombie_kills', unlock_at: 100 },
        { id: 'flawless_stage', name: '铜墙铁壁', description: '', hidden: true }
      ],
      leaderboards: [{ id: 'high_score', name: '最高得分', sort: 'desc', keep: 'best', display: 'number' }]
    },
    values,
    unlocked: {},
    on() {},
    async ready() {},
    get: (id) => values[id] || 0,
    inc(id, n) {
      if (!enabled) return;
      calls.inc[id] = (calls.inc[id] || 0) + n;
      values[id] = (values[id] || 0) + n;
    },
    set(id, v) {
      if (!enabled) return;
      calls.set[id] = v;
      values[id] = v;
    },
    unlock(id) {
      if (!enabled) return;
      calls.unlock.push(id);
    },
    submit(id, score) {
      if (!enabled) return;
      calls.submit[id] = score;
    },
    async store() {
      calls.stores++;
      return { ok: true };
    },
    async board() {
      return { id: 'high_score', top: [{ rank: 1, nickname: '小飞', score: 900 }], me: { rank: 1, score: 900 } };
    }
  };
  return { calls, gh, factory: { connect: () => gh } };
}

async function makeClient(enabled = true) {
  const f = fakeSdk(enabled);
  __setStatsFactory(f.factory);
  const c = new ProgressClient();
  // detectGameId 在 node 里返回空串（没有 window），init 仍然要能跑通
  await c.init();
  return { client: c, ...f };
}

console.log('== 1. RunStats 分桶 ==');
{
  const run = new RunStats();
  run.add(0, 'kills', 3);
  run.add(2, 'kills', 5);
  run.add(2, 'drops', 7);
  run.bumpWave(4);
  run.bumpWave(2); // 只记最高
  run.hpLost += 12;
  run.markStage('fruitMerge');
  run.markStage('fruitVsZombie');
  run.markStage('fruitVsZombie'); // 重复进入只算一次

  eq('0 号位击杀 3', run.forSeat(0).kills, 3);
  eq('2 号位击杀 5（不串桶）', run.forSeat(2).kills, 5);
  eq('2 号位投放 7', run.forSeat(2).drops, 7);
  eq('1 号位没打过，是 0', run.forSeat(1).kills, 0);
  eq('波次取最高', run.forSeat(0).wave, 4);
  eq('掉血是全队共享的', run.forSeat(3).hpLost, 12);
  eq('阶段去重', run.forSeat(0).stages.length, 2);
  ok('阶段记录了僵尸关', run.forSeat(0).stages.includes('fruitVsZombie'));
  eq('座位越界收敛到 0 号位', run.forSeat(99).kills, 3);
  eq('未定义字段不写坏桶', (run.add(0, 'nonexistent', 5), run.forSeat(0).kills), 3);
}

console.log('\n== 2. recordMerge：合成 / 大西瓜 / 最高等级 ==');
{
  const run = new RunStats();
  const game = { runStats: run };
  const TOP = levels.length - 1;
  recordMerge(game, 1, 3);
  recordMerge(game, 1, TOP);
  recordMerge(game, 1, 2);

  eq('合成计 3 次', run.forSeat(1).merges, 3);
  eq('顶级水果算一个大西瓜', run.forSeat(1).watermelons, 1);
  eq('最高等级取 max 而非最后一次', run.forSeat(1).maxFruitLevel, TOP);
  ok('game 没有 runStats 时不炸', (recordMerge({}, 0, 3), true));
}

console.log('\n== 3. encode / decode：host 把战绩广播给 guest ==');
{
  const host = new RunStats();
  host.add(0, 'kills', 11);
  host.add(1, 'kills', 22);
  host.add(1, 'merges', 5);
  host.bump(1, 'maxFruitLevel', 7);
  host.bumpWave(9);
  host.hpLost += 30;
  host.markStage('fruitVsZombie');
  host.online = true;

  // guest 本地那份是空的 —— 物理压根没在它那儿跑
  const guest = new RunStats();
  eq('guest 上报前本地是空的', guest.forSeat(1).kills, 0);
  guest.decode(host.encode());

  eq('guest 拿到自己那格击杀', guest.forSeat(1).kills, 22);
  eq('guest 也能看到 host 那格', guest.forSeat(0).kills, 11);
  eq('合成同步', guest.forSeat(1).merges, 5);
  eq('最高等级同步', guest.forSeat(1).maxFruitLevel, 7);
  eq('波次同步', guest.forSeat(0).wave, 9);
  eq('掉血同步', guest.forSeat(0).hpLost, 30);
  ok('阶段同步', guest.forSeat(0).stages.includes('fruitVsZombie'));
  ok('开始时间同步（生存时长才对得上）', guest.startedAt === host.startedAt);
  ok('decode(null) 不炸', (guest.decode(null), true));
  ok('decode(垃圾) 不炸', (guest.decode({ s: 'nope', st: null }), true));

  const size = JSON.stringify(host.encode()).length;
  ok(`编码后 ${size} 字节，远低于 8KB 报文上限`, size < 800, String(size));
}

console.log('\n== 4. reportRun：一局战绩 → 平台语义 ==');
{
  const { client, calls } = await makeClient(true);
  ok('假 SDK 接上了', client.enabled);

  const run = new RunStats();
  run.online = true;
  run.add(0, 'kills', 150);
  run.add(0, 'merges', 40);
  run.add(0, 'drops', 88);
  run.add(0, 'cards', 6);
  run.add(0, 'watermelons', 2);
  run.bump(0, 'maxFruitLevel', 9);
  run.bumpWave(12);
  run.markStage('fruitMerge');
  run.markStage('fruitVsZombie');

  await client.reportRun(run.forSeat(0), { score: 12345, win: true, champion: true });

  eq('只出网一次', calls.stores, 1);
  eq('局数 +1', calls.inc.games_played, 1);
  eq('联机局数 +1', calls.inc.mp_games_played, 1);
  eq('通关 +1', calls.inc.stage_clears, 1);
  eq('通关时不算阵亡', calls.inc.deaths, undefined);
  eq('联机夺冠 +1', calls.inc.mp_wins, 1);
  eq('击杀累计走 inc', calls.inc.zombie_kills, 150);
  eq('合成累计走 inc', calls.inc.merges, 40);
  eq('投放累计走 inc', calls.inc.fruits_dropped, 88);
  eq('卡牌累计走 inc', calls.inc.cards_picked, 6);
  eq('大西瓜累计走 inc', calls.inc.watermelons_made, 2);
  eq('得分累计走 inc', calls.inc.total_score, 12345);
  eq('打到僵尸关的隐藏统计 +1', calls.inc.runs_reached_zombie, 1);

  eq('最高分走 set（服务端 increment_only 取 max）', calls.set.best_score, 12345);
  eq('单局最多击杀走 set', calls.set.best_zombie_kills, 150);
  eq('最远波次走 set', calls.set.best_wave, 12);
  eq('最高合成等级走 set', calls.set.max_fruit_level, 9);
  ok('生存时长走 set', typeof calls.set.best_survival_seconds === 'number');

  eq('得分上榜', calls.submit.high_score, 12345);
  eq('击杀上榜', calls.submit.top_kills, 150);
  eq('波次上榜', calls.submit.deep_run, 12);
  eq('合成上榜用的是累计值', calls.submit.merge_master, 40);
  ok('生存时长上榜', 'survivor' in calls.submit);

  ok('零掉血通关解锁「铜墙铁壁」', calls.unlock.includes('flawless_stage'));
}

console.log('\n== 5. 失败局 / 掉过血 / 单机 ==');
{
  const { client, calls } = await makeClient(true);
  const run = new RunStats();
  run.online = false;
  run.hpLost = 40;
  run.markStage('fruitMerge');   // 死在第一关，一只僵尸都没见到

  await client.reportRun(run.forSeat(0), { score: 200, win: false, champion: false });

  eq('阵亡 +1', calls.inc.deaths, 1);
  eq('没通关就不算 stage_clears', calls.inc.stage_clears, undefined);
  eq('单机不算联机局数', calls.inc.mp_games_played, undefined);
  eq('单机不算夺冠', calls.inc.mp_wins, undefined);
  ok('掉过血就不该解锁「铜墙铁壁」', !calls.unlock.includes('flawless_stage'));
  eq('没打到僵尸关就不加那个隐藏统计', calls.inc.runs_reached_zombie, undefined);
  eq('零击杀不占用击杀榜', calls.submit.top_kills, undefined);
}

console.log('\n== 6. 未登录：全部空转 ==');
{
  const { client, calls } = await makeClient(false);
  ok('未登录时 enabled 为 false', !client.enabled);
  const run = new RunStats();
  run.add(0, 'kills', 9);
  const res = await client.reportRun(run.forSeat(0), { score: 500, win: true });
  eq('不出网', calls.stores, 0);
  eq('没有任何 inc', Object.keys(calls.inc).length, 0);
  eq('返回 null 而不是抛异常', res, null);
  // 目录是公开信息，未登录也能看，只是数值全 0 —— 面板照常渲染，配一句「登录后才有数据」
  eq('未登录仍能看到统计目录', client.statRows().length, 2);
  ok('未登录时数值全是 0', client.statRows().every((r) => r.value === 0));
  eq('未登录时 loggedIn 为 false', client.loggedIn, false);
}

console.log('\n== 7. 面板取数 ==');
{
  const { client } = await makeClient(true);
  const rows = client.statRows();
  eq('隐藏统计不出现在面板', rows.length, 2);
  ok('统计带上了中文名', rows.some((r) => r.name === '击杀僵尸数'));

  const achs = client.achievementRows();
  eq('成就两条', achs.length, 2);
  const hunter = achs.find((a) => a.id === 'zombie_hunter');
  eq('未解锁', hunter.unlocked, false);
  eq('零进度', hunter.progress, 0);

  // 打一局把击杀刷到 50，进度条应该走到一半
  const run = new RunStats();
  run.add(0, 'kills', 50);
  run.markStage('fruitMerge');
  await client.reportRun(run.forSeat(0), { score: 1, win: false });
  const after = client.achievementRows().find((a) => a.id === 'zombie_hunter');
  eq('50/100 的进度是 0.5', after.progress, 0.5);

  const tally = client.achievementTally();
  eq('已解锁 0 个', tally.done, 0);
  eq('总共 2 个', tally.total, 2);

  eq('board() 首次调用返回 null（异步拉）', client.board('high_score'), null);
  await new Promise((r) => setTimeout(r, 10));
  const board = client.board('high_score');
  ok('第二次读到缓存的榜', board && board.top && board.top.length === 1, JSON.stringify(board));
  eq('榜首昵称', board.top[0].nickname, '小飞');
}

console.log('\n== 8. 上报异常不影响游戏 ==');
{
  const f = fakeSdk(true);
  f.gh.store = async () => { throw new Error('网络炸了'); };
  __setStatsFactory(f.factory);
  const client = new ProgressClient();
  await client.init();
  const run = new RunStats();
  run.add(0, 'kills', 1);
  let threw = false;
  let res;
  try {
    res = await client.reportRun(run.forSeat(0), { score: 1, win: false });
  } catch (e) {
    threw = true;
  }
  ok('store 抛异常时 reportRun 自己吞掉', !threw);
  eq('返回 null', res, null);
}

__setStatsFactory(null);
console.log('\n----------------------------------------------------');
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败：' + fails.join('、'));
  process.exit(1);
}
