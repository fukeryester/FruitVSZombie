/**
 * GameHub 进度系统客户端（统计 / 成就 / 排行榜）
 * ------------------------------------------------------------------
 * 对站点的 `/static/gamehub-stats.js` 做一层封装，补上游戏侧真正需要的东西：
 *   · 环境探测：微信小游戏包与无头测试里没有 window，整个模块降级成空转；
 *   · SDK 动态加载（站点版本取不到就回退包内自带的同名文件）；
 *   · 把「一局的战绩」翻译成平台的 inc / set / unlock / submit 语义；
 *   · 缓存一份目录 + 我的数值，给局内的数据面板直接读。
 *
 * 鉴权和房间一样走**同域 Cookie**：游戏跑在已登录站点的
 * `/g/{id}/v/{vid}/index.html` 里，fetch 自动带会话。**不要**把 API Token 写进包里。
 * 未登录时 SDK 的 enabled 为 false，所有写操作空转，不影响游戏自己的本地存档。
 *
 * 全部 API 都不会抛异常：进度系统挂了也只是少几个数字，绝不能让游戏崩。
 */
import { detectGameId } from './roomClient.js';

const SDK_URLS = ['/static/gamehub-stats.js', './gamehub-stats.js'];

/** 被测试注入的 SDK（正常运行恒为 null，见 __setStatsFactory） */
let _forced = null;
let sdkPromise = null;

export function isProgressSupported() {
  if (_forced) return true;
  return typeof window !== 'undefined' &&
    typeof window.fetch === 'function' &&
    typeof document !== 'undefined';
}

/**
 * 测试注入点：把统计 SDK 换成进程内的假实现，这样上报映射能在 node 里无头断言。
 * @param {object|null} factory 形如 { connect(opts) => ghLike }
 */
export function __setStatsFactory(factory) {
  _forced = factory || null;
  sdkPromise = factory ? Promise.resolve(factory) : null;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('load fail: ' + src));
    document.head.appendChild(el);
  });
}

async function loadStatsSdk() {
  if (_forced) return _forced;
  if (!isProgressSupported()) return null;
  if (window.GameHubStats) return window.GameHubStats;
  if (!sdkPromise) {
    sdkPromise = (async () => {
      for (const url of SDK_URLS) {
        try {
          await injectScript(url);
          if (window.GameHubStats) return window.GameHubStats;
        } catch (e) {
          /* 换下一个候选地址 */
        }
      }
      return null;
    })();
  }
  return sdkPromise;
}

/**
 * 阶段 id → 「打到过这一关」的统计名。
 * 只登记需要单独计数的阶段；第一关人人都到，没必要占一个统计位。
 */
const STAGE_STAT = { fruitVsZombie: 'runs_reached_zombie' };

export class ProgressClient {
  constructor() {
    this.gh = null;
    this.gameId = '';
    /** 目录 + 我的数值，给数据面板读；SDK 没起来时恒为空 */
    this.defs = { stats: [], achievements: [], leaderboards: [] };
    this.values = {};
    this.unlocked = {};
    this.loggedIn = false;
    this.ready = false;
    /** 平台内置只读统计：我在这款游戏上的总游玩秒数 */
    this.playtimeSeconds = 0;
    /** 有进度记录的玩家总数（展示「全服 N 人玩过」） */
    this.playerCount = 0;
    /** 成就 id → { unlocks, percent } 全球完成率，SDK 自己不留这份 */
    this.globalRates = {};
    /** 最近一次解锁的成就，局内飘一条提示 */
    this.lastUnlocked = null;
    this._onUnlock = [];
    this._boards = new Map();
  }

  /** 是否真的能写（未登录 / 没 SDK 时为 false，调用方一般不用判断） */
  get enabled() {
    return !!(this.gh && this.gh.enabled);
  }

  /** 启动：加载 SDK 并拉一次目录。失败就静默降级。 */
  async init() {
    try {
      const Sdk = await loadStatsSdk();
      if (!Sdk) return this;
      this.gameId = detectGameId();
      this.gh = Sdk.connect(this.gameId ? { gameId: this.gameId } : undefined);
      this.gh.on('achievement', (item) => {
        this.lastUnlocked = item;
        this.unlocked[item.id] = true;
        for (const fn of this._onUnlock) {
          try {
            fn(item);
          } catch (e) {
            /* 回调自己的问题不该影响上报 */
          }
        }
      });
      await this.gh.ready();
      this._pullCache();
      await this._pullExtras();
    } catch (e) {
      console.warn('[progress] init 失败，进度系统降级', e);
    }
    return this;
  }

  /**
   * SDK 的 ready() 只留下目录和我的数值，把 stats/me 里另外几样有用的东西丢了：
   * 游玩时长、全服玩家数、每个成就的全球完成率。面板要展示这些，所以自己再取一次。
   */
  async _pullExtras() {
    if (!this.gameId || typeof fetch !== 'function') return;
    try {
      const res = await fetch(`/api/v1/games/${encodeURIComponent(this.gameId)}/stats/me`, {
        credentials: 'same-origin'
      });
      if (!res.ok) return;
      const data = await res.json();
      this.playtimeSeconds = data.playtime_seconds || 0;
      this.playerCount = data.player_count || 0;
      this.globalRates = {};
      for (const a of data.achievements || []) {
        this.globalRates[a.id] = { unlocks: a.unlocks || 0, percent: a.percent || 0 };
      }
    } catch (e) {
      /* 拿不到就不展示这几项，不影响上报 */
    }
  }

  /** 有新成就解锁时回调（局内飘字用） */
  onUnlock(fn) {
    this._onUnlock.push(fn);
  }

  _pullCache() {
    if (!this.gh) return;
    this.defs = {
      stats: this.gh.defs.stats || [],
      achievements: this.gh.defs.achievements || [],
      leaderboards: this.gh.defs.leaderboards || []
    };
    this.values = { ...this.gh.values };
    this.unlocked = { ...this.gh.unlocked };
    this.loggedIn = !!this.gh.enabled;
    this.ready = true;
  }

  /** 读一个统计的当前值（含本局还没出网的增量） */
  get(id) {
    if (!this.gh) return 0;
    return this.gh.get(id) || 0;
  }

  /** 数据面板用：非隐藏统计的 [{ id, name, value }] */
  statRows() {
    if (!this.gh) return [];
    return this.defs.stats
      .filter((s) => !s.hidden)
      .map((s) => ({ id: s.id, name: s.display_name || s.id, value: this.gh.get(s.id) || 0 }));
  }

  /** 数据面板用：成就 [{ id, name, description, unlocked, progress }] */
  achievementRows() {
    if (!this.gh) return [];
    return this.defs.achievements.map((a) => {
      const done = !!this.unlocked[a.id];
      // 进度型成就能算百分比；完成型只有 0 / 1
      let progress = done ? 1 : 0;
      if (!done && a.bind_stat && a.unlock_at > 0) {
        progress = Math.min(1, (this.gh.get(a.bind_stat) || 0) / a.unlock_at);
      }
      return {
        id: a.id,
        name: a.name || a.id,
        description: a.description || '',
        bindStat: a.bind_stat || '',
        unlockAt: a.unlock_at || 0,
        unlocked: done,
        progress,
        percent: (this.globalRates[a.id] || {}).percent || 0
      };
    });
  }

  /** 已解锁 / 总数 */
  achievementTally() {
    const rows = this.achievementRows();
    return { done: rows.filter((r) => r.unlocked).length, total: rows.length };
  }

  /**
   * 拉一个排行榜（带缓存，面板可以每帧读）。
   * @returns {object|null} 首次调用返回 null，取回后再读就有值
   */
  board(id, limit = 10) {
    if (!this.gh) return null;
    if (this._boards.has(id)) return this._boards.get(id);
    this._boards.set(id, null); // 占位，避免重复请求
    this.gh
      .board(id, limit)
      .then((data) => this._boards.set(id, data || null))
      .catch(() => this._boards.set(id, null));
    return null;
  }

  /** 丢掉排行榜缓存，下次读会重新拉（结算后调一次） */
  refreshBoards() {
    this._boards.clear();
  }

  /**
   * 把一局的战绩写进平台。
   *
   * 累计类用 inc（平台按 max_delta 夹紧），最好成绩类用 set + increment_only
   * （服务端发现比旧值小会直接跳过，正是「取最好」的语义）。
   * 排行榜是独立的一套，各榜单独 submit。
   *
   * @param {object} run  RunStats.forSeat() 的结果
   * @param {object} opts { score, win, champion } —— champion 是联机里本局第一名
   */
  async reportRun(run, opts = {}) {
    if (!this.enabled || !run) return null;
    try {
      const gh = this.gh;
      const kills = run.kills | 0;
      const score = Math.max(0, opts.score | 0);
      const reachedZombie = (run.stages || []).includes('fruitVsZombie');

      // ---- 累计类 ----
      gh.inc('games_played', 1);
      if (run.online) gh.inc('mp_games_played', 1);
      if (opts.win) gh.inc('stage_clears', 1);
      else gh.inc('deaths', 1);
      if (opts.champion) gh.inc('mp_wins', 1);
      gh.inc('fruits_dropped', run.drops | 0);
      gh.inc('merges', run.merges | 0);
      gh.inc('watermelons_made', run.watermelons | 0);
      gh.inc('zombie_kills', kills);
      gh.inc('cards_picked', run.cards | 0);
      gh.inc('total_score', score);
      for (const id of run.stages || []) {
        const stat = STAGE_STAT[id];
        if (stat) gh.inc(stat, 1);
      }

      // ---- 最好成绩类（靠 increment_only 在服务端取 max）----
      gh.set('best_score', score);
      gh.set('best_zombie_kills', kills);
      gh.set('best_wave', run.wave | 0);
      gh.set('max_fruit_level', run.maxFruitLevel | 0);
      gh.set('best_survival_seconds', run.seconds | 0);

      // ---- 完成型成就：通关僵尸关且一滴血没掉 ----
      if (opts.win && reachedZombie && (run.hpLost | 0) === 0) gh.unlock('flawless_stage');

      // ---- 排行榜（每榜每人一行，keep=best）----
      gh.submit('high_score', score);
      if (kills > 0) gh.submit('top_kills', kills);
      gh.submit('merge_master', gh.get('merges') || 0);
      if (run.wave > 0) gh.submit('deep_run', run.wave | 0);
      gh.submit('survivor', run.seconds | 0);

      const res = await gh.store();
      this._pullCache();
      this.refreshBoards();
      this._pullExtras();
      return res;
    } catch (e) {
      console.warn('[progress] 上报失败', e);
      return null;
    }
  }
}

/** 全局单例：main.js 构造时 init 一次，各处直接引用 */
export const progress = new ProgressClient();
