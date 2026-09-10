/**
 * 一局（run）的战绩计数器 —— 挂在 game 上，跨阶段累加
 * ------------------------------------------------------------------
 * 为什么要单独一层，而不是各 state 自己数：
 *
 *  1. 一局要穿过两个阶段（水果合成 → 水果大战僵尸），state 会被整个换掉，
 *     计数必须活在 game 上；
 *  2. 联机是**主机权威**：投放、合成、击杀、加分全都只在 host 的进程里执行，
 *     guest 那边这些函数根本不跑。所以计数按**座位**分桶，结算时由 host 把
 *     整张表广播下去，每个客户端只挑自己那一格上报给平台。
 *
 * 平台的统计有 max_delta 夹紧，本地也就没必要防溢出：一局能投几千个水果的话
 * 被夹掉才是对的。
 */
import { MAX_PLAYERS } from '../config/net.js';
import { levels } from '../config/balls.js';

/** 合成出的最高级水果就是大西瓜，用它统计 watermelons_made */
const TOP_LEVEL = levels.length - 1;

/**
 * 记一次合成。两个阶段都会合成水果，逻辑一样，抽出来共用。
 * @param {object} game     Main 实例
 * @param {number} seat     收益归属座位
 * @param {number} newLevel 合成出的水果等级
 */
export function recordMerge(game, seat, newLevel) {
  const run = game && game.runStats;
  if (!run) return;
  run.add(seat, 'merges', 1);
  run.bump(seat, 'maxFruitLevel', newLevel);
  if (newLevel >= TOP_LEVEL) run.add(seat, 'watermelons', 1);
}

/**
 * 每座位累加的字段。
 * 注意这里**不记分数**：结算画面已经有一份权威的按座位得分（host 算好后广播，
 * guest 还会按自己座位重算），再存一份只会多一个对不上的风险。上报时由调用方
 * 把那个分数传进来。
 */
const SUM_KEYS = ['drops', 'merges', 'watermelons', 'kills', 'cards'];
/** 每座位取最大值的字段 */
const MAX_KEYS = ['maxFruitLevel'];

function emptySeat() {
  const seat = {};
  for (const k of SUM_KEYS) seat[k] = 0;
  for (const k of MAX_KEYS) seat[k] = 0;
  return seat;
}

export class RunStats {
  constructor() {
    this.reset();
  }

  /** 开新一局：大厅点开始 / 房间开局时调 */
  reset() {
    this.seats = Array.from({ length: MAX_PLAYERS }, emptySeat);
    this.startedAt = Date.now();
    // 下面几项是**全队共享**的（波次、生存时长、掉血、到过哪些阶段）
    this.wave = 0;
    this.hpLost = 0;
    this.stages = {};
    this.online = false;
  }

  /** 本局已进行的秒数（结算时作为生存时长上榜） */
  get seconds() {
    return Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
  }

  _seat(seat) {
    const i = seat == null || seat < 0 || seat >= MAX_PLAYERS ? 0 : seat;
    return this.seats[i];
  }

  /** 累加一个计数（seat 为空按 0 号位算，等于单机） */
  add(seat, key, n = 1) {
    if (!n) return;
    const bucket = this._seat(seat);
    if (bucket[key] === undefined) return;
    bucket[key] += n;
  }

  /** 抬高一个"最好成绩"字段 */
  bump(seat, key, value) {
    const bucket = this._seat(seat);
    if (bucket[key] === undefined) return;
    if (value > bucket[key]) bucket[key] = value;
  }

  /** 记一次到达某阶段（同一局重复进入只算一次） */
  markStage(id) {
    this.stages[id] = true;
  }

  /** 全队波次只记最高 */
  bumpWave(n) {
    if (n > this.wave) this.wave = n;
  }

  /**
   * 打包成可以塞进网络报文的紧凑结构。
   * host 在结算时广播它，guest 收到后当成自己的本局战绩。
   */
  encode() {
    return {
      t: this.startedAt,
      w: this.wave,
      hl: this.hpLost,
      st: Object.keys(this.stages),
      s: this.seats.map((seat) => [...SUM_KEYS, ...MAX_KEYS].map((k) => seat[k] | 0))
    };
  }

  /** guest：用 host 广播的表覆盖本地（本地那份是空的，物理没在这儿跑） */
  decode(data) {
    if (!data) return;
    const keys = [...SUM_KEYS, ...MAX_KEYS];
    if (typeof data.t === 'number') this.startedAt = data.t;
    this.wave = data.w | 0;
    this.hpLost = data.hl | 0;
    this.stages = {};
    for (const id of data.st || []) this.stages[id] = true;
    if (Array.isArray(data.s)) {
      data.s.forEach((row, i) => {
        if (i >= this.seats.length || !Array.isArray(row)) return;
        keys.forEach((k, j) => {
          this.seats[i][k] = row[j] | 0;
        });
      });
    }
  }

  /**
   * 取某个座位的本局战绩，补上全队共享字段。
   * 这就是要上报给平台的那一份。
   */
  forSeat(seat) {
    const mine = this._seat(seat);
    return {
      ...mine,
      wave: this.wave,
      hpLost: this.hpLost,
      seconds: this.seconds,
      stages: Object.keys(this.stages),
      online: this.online
    };
  }
}
