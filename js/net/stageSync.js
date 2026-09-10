/**
 * 局内状态同步（StageSync）—— 每个局内 state 挂一个
 * ------------------------------------------------------------------
 * 模型：**主机权威 + 状态同步**。
 *
 *   host（座位号最小的那台，开局时锁定）
 *     · 跑完整物理，是唯一的判定方；
 *     · 每 1/SNAPSHOT_HZ 秒把「全场刚体 + 四个投射口 + 阶段字段」广播出去；
 *     · 收 guest 的输入（投射口横坐标 / 投放请求 / 选卡 / 复活请求）。
 *
 *   guest
 *     · 完全不跑物理：每帧把插值后的刚体数组直接塞进 state.world.bodies，
 *       原有渲染代码一行不用改就能画出 host 的世界；
 *     · 自己的投射口本地即时响应（不等 RTT），横坐标上报给 host，
 *       等级 / 冷却以 host 下发为准；
 *     · 其他玩家的投射口按快照 lerp。
 *
 * state 需要实现的钩子（见 fruitMergeState / fruitVsZombieState）：
 *   collectExtra()            → 阶段自有字段（分数以外的 HUD 数据）
 *   applyExtra(x)             ← guest 侧写回
 *   afterGuestSync(view)      ← guest 每帧同步完的收尾（重建 core / artifacts 等）
 *   rollLauncherLevel()       → host 给某个投射口摇一个新水果等级
 *   spawnDrop(x, level, seat) → host 真正投放
 *   buildArenaDesc()          → host 导出场地（无场地的阶段返回 null）
 *   applyArenaDesc(desc)      ← guest 按描述重建场地
 */
import {
  SNAPSHOT_HZ, INPUT_HZ, INTERP_DELAY_MS, HOST_TIMEOUT_MS, MAX_PACKET_BYTES
} from '../config/net.js';
import { M } from './protocol.js';
import { SnapshotBuffer, encodeBodies, encodeLaunchers } from './snapshot.js';

/** 每帧最多同步多少个爆点特效（防止大混战时把包撑爆） */
const MAX_BURSTS_PER_SNAP = 10;

/**
 * guest 收到 host 的「切阶段」命令：锁定 host、暂存场地描述，然后切状态。
 * 房间界面（RoomState）与局内（StageSync）都会用到，所以抽成独立函数。
 * @param {object} game Main 实例
 * @param {object} data STAGE 报文
 * @param {string} from 发送者 client_id（即本局 host）
 */
export function applyStageCommand(game, data, from) {
  const session = game.net;
  if (!session) return;
  session.beginMatchAsGuest(from);
  session.pendingStage = {
    id: data.id,
    carry: data.cs | 0,
    arena: data.ar || null,
    seatScores: Array.isArray(data.sc) ? data.sc.slice() : []
  };
  const next = game.createStageState(data.id, data.cs | 0);
  if (next) game.states.switchTo(next);
}

export class StageSync {
  /**
   * @param {object} state 局内 state（需实现上面列出的钩子）
   * @param {string} stageId 阶段 id
   */
  constructor(state, stageId) {
    this.state = state;
    this.game = state.game;
    this.session = state.game.net;
    this.stageId = stageId;

    this.seq = 0;
    this.snapTimer = 0;
    this.inputTimer = 0;
    this.inputSeq = 0;
    this.buffer = new SnapshotBuffer();
    this.lastSnapAt = 0;
    this.disconnected = false;

    /** host：seat → 远端投射口的权威状态；guest：seat → 插值后的展示状态 */
    this.remote = new Map();
    /** guest：host 下发的「我这个投射口」的等级、下一个预览与冷却 */
    this.mine = { level: 0, next: 0, ready: true };
    /** 本帧待广播的爆点特效与 Toast */
    this._bursts = [];
    this._toasts = [];
    /** 结算时汇总的各座位最终分（host 用） */
    this.finalScores = new Map();
    this._detach = null;
  }

  get online() {
    return !!(this.session && this.session.inMatch);
  }

  get isHost() {
    return !this.online || this.session.isHost;
  }

  get isGuest() {
    return this.online && !this.session.isHost;
  }

  get mySeat() {
    return this.online ? this.session.seat : 0;
  }

  get seats() {
    if (!this.online) return [0];
    return this.session.roster.map((m) => m.seat);
  }

  get playerCount() {
    return this.online ? this.session.playerCount : 1;
  }

  nameOf(seat) {
    return this.online ? this.session.nameOf(seat) : '我';
  }

  // ---------------- 生命周期 ----------------

  /**
   * 接管报文。
   * 结算层是 push 到局内层之上的，会触发局内层的 onExit → 这里断开；
   * 复活 pop 回来时局内层的 onResume 会再调一次 attach，并清空快照缓冲
   * （结算期间攒下的旧帧已经没有意义，留着只会让画面先倒带一下）。
   */
  attach() {
    if (!this.online || this._detach) return;
    this._detach = this.session.setHandler((data, from) => this.handle(data, from));
    this.buffer.clear();
    this.lastSnapAt = Date.now();
    this.disconnected = false;
  }

  detach() {
    if (this._detach) {
      this._detach();
      this._detach = null;
    }
  }

  onEnter() {
    if (!this.online) return;
    this.attach();
    if (this.isHost) {
      for (const seat of this.seats) {
        if (seat === this.mySeat) continue;
        this._ensureRemote(seat);
      }
    }
  }

  onExit() {
    this.detach();
  }

  /** host 进入本阶段后立刻通知所有人切过来（附带场地描述与继承分数） */
  announceStage(carryScore) {
    if (!this.online || !this.isHost) return;
    this.session.broadcast({
      t: M.STAGE,
      id: this.stageId,
      cs: carryScore | 0,
      ar: this.state.buildArenaDesc ? this.state.buildArenaDesc() : null,
      sc: this.state.seatScores || []
    }, { critical: true });
  }

  // ---------------- 投射口 ----------------

  _ensureRemote(seat) {
    let L = this.remote.get(seat);
    if (!L) {
      L = {
        seat,
        x: this.game.screenW / 2,
        level: this.state.rollLauncherLevel ? this.state.rollLauncherLevel() : 0,
        next: this.state.rollLauncherLevel ? this.state.rollLauncherLevel() : 0,
        ready: true,
        delay: 0,
        dropWanted: false
      };
      this.remote.set(seat, L);
    }
    return L;
  }

  /** host：推进远端投射口（冷却 + 投放请求） */
  hostUpdateLaunchers(dt) {
    if (!this.online || !this.isHost) return;
    for (const L of this.remote.values()) {
      if (!L.ready) {
        L.delay -= dt;
        if (L.delay <= 0) {
          L.ready = true;
          L.level = L.next;
          L.next = this.state.rollLauncherLevel();
        }
      }
      if (L.dropWanted) {
        L.dropWanted = false;
        if (L.ready) {
          this.state.spawnDrop(L.x, L.level, L.seat);
          L.ready = false;
          L.delay = 0.35;
        }
      }
    }
  }

  /** 本机投射口 + 所有远端投射口，用于打包与渲染 */
  launcherViews() {
    const out = [];
    const cur = this.state.current;
    out.push({
      seat: this.mySeat,
      x: cur ? cur.x : (this.state.touchX ?? this.game.screenW / 2),
      level: cur ? cur.level : (this.state.nextLevel | 0),
      ready: !!cur,
      next: this.state.nextLevel | 0
    });
    for (const L of this.remote.values()) {
      out.push({ seat: L.seat, x: L.x, level: L.level, ready: L.ready, next: L.next });
    }
    return out;
  }

  /** 渲染用：别人的投射口（不含自己；单机恒为空数组） */
  remoteViews() {
    if (!this.online) return [];
    const out = [];
    for (const L of this.remote.values()) {
      if (L.seat === this.mySeat) continue;
      out.push(L);
    }
    return out;
  }

  /** guest：把自己的投射口横坐标与投放请求发给 host */
  guestSendInput(dt, x, wantDrop) {
    if (!this.isGuest) return;
    this.inputTimer -= dt;
    if (!wantDrop && this.inputTimer > 0) return;
    this.inputTimer = 1 / INPUT_HZ;
    this.session.sendToHost({
      t: M.INPUT,
      x: Math.round(x),
      d: wantDrop ? 1 : 0,
      q: ++this.inputSeq
    }, { critical: !!wantDrop });
  }

  // ---------------- 快照 ----------------

  /** host：按频率广播世界快照 */
  hostTick(dt) {
    if (!this.online || !this.isHost) return;
    this.snapTimer -= dt;
    if (this.snapTimer > 0) return;
    this.snapTimer = 1 / SNAPSHOT_HZ;
    this.session.broadcast(this._buildSnapshot());
  }

  _buildSnapshot() {
    const state = this.state;
    const msg = {
      t: M.SNAP,
      q: ++this.seq,
      b: encodeBodies(state.world.bodies),
      L: encodeLaunchers(this.launcherViews()),
      S: (state.seatScores || []).slice(),
      x: state.collectExtra ? state.collectExtra() : {}
    };
    const cv = state.cardSystem && state.cardSystem.voteProgress();
    if (cv) msg.cv = cv;
    if (this._bursts.length) msg.e = this._bursts.splice(0, MAX_BURSTS_PER_SNAP);
    if (this._toasts.length) msg.tx = this._toasts.splice(0, 4);
    this._bursts.length = 0;
    this._toasts.length = 0;

    // 体积兜底：8KB 是服务端硬上限，超了整包会被拒。
    // 先砍特效，再从最小的刚体开始丢（视觉影响最小，下一帧就会补回来）。
    let text = JSON.stringify(msg);
    if (text.length > MAX_PACKET_BYTES) {
      delete msg.e;
      delete msg.tx;
      text = JSON.stringify(msg);
    }
    while (text.length > MAX_PACKET_BYTES && msg.b.length > 6) {
      msg.b = this._dropSmallestBodies(msg.b, Math.ceil(msg.b.length / 6 * 0.15));
      text = JSON.stringify(msg);
    }
    return msg;
  }

  /** 从扁平刚体数组里丢掉半径最小的 n 个 */
  _dropSmallestBodies(flat, n) {
    const idx = [];
    for (let i = 0; i < flat.length; i += 6) idx.push(i);
    idx.sort((a, b) => flat[a + 3] - flat[b + 3]);
    const drop = new Set(idx.slice(0, n));
    const out = [];
    for (let i = 0; i < flat.length; i += 6) {
      if (drop.has(i)) continue;
      for (let k = 0; k < 6; k++) out.push(flat[i + k]);
    }
    return out;
  }

  /** host：登记一个要同步出去的爆点特效 */
  pushBurst(e) {
    if (!this.online || !this.isHost) return;
    if (this._bursts.length >= MAX_BURSTS_PER_SNAP) return;
    this._bursts.push([Math.round(e.x), Math.round(e.y), Math.round(e.r), e.color || '#ffffff']);
  }

  /** host：登记一条要同步出去的 Toast */
  pushToast(text) {
    if (!this.online || !this.isHost) return;
    if (this._toasts.length >= 4) return;
    this._toasts.push(String(text));
  }

  /**
   * guest：把插值后的世界写进 state。
   * 直接替换 world.bodies —— 里面是「只有渲染字段的假刚体」，
   * guest 永远不会调用 world.step()，所以不需要真的 Body 实例。
   */
  guestSync() {
    if (!this.isGuest) return null;
    const now = Date.now();
    if (this.lastSnapAt && now - this.lastSnapAt > HOST_TIMEOUT_MS) this.disconnected = true;
    const view = this.buffer.sample(now, INTERP_DELAY_MS);
    if (!view) return null;

    const state = this.state;
    state.world.bodies = view.bodies;
    if (Array.isArray(view.data.S)) {
      state.seatScores = view.data.S.slice();
      state.score = state.seatScores.reduce((a, b) => a + (b || 0), 0);
    }
    if (state.applyExtra && view.data.x) state.applyExtra(view.data.x);

    this.remote.clear();
    for (const [seat, L] of view.launchers) {
      if (seat === this.mySeat) {
        this.mine.level = L.level;
        this.mine.next = L.next;
        this.mine.ready = L.ready;
      } else {
        this.remote.set(seat, L);
      }
    }
    if (state.afterGuestSync) state.afterGuestSync(view);
    return view;
  }

  // ---------------- 收报文 ----------------

  handle(data, from) {
    if (!data || !data.t) return;
    const state = this.state;
    switch (data.t) {
      case M.SNAP:
        if (!this.isGuest) return;
        this.lastSnapAt = Date.now();
        this.disconnected = false;
        if (data.cv && state.cardSystem) state.cardSystem.onVoteProgress(data.cv);
        if (this.buffer.push(data)) this._playFrameFx(data);
        break;

      case M.INPUT: {
        if (!this.isHost) return;
        const seat = this.session.seatOfClient(from);
        if (seat < 0 || seat === this.mySeat) return;
        const L = this._ensureRemote(seat);
        L.x = data.x;
        if (data.d) L.dropWanted = true;
        break;
      }

      case M.CARD_OPEN:
        if (state.cardSystem) state.cardSystem.onRemoteOpen(data.ids, data.dl, data.ck);
        break;

      case M.CARD_PICK: {
        if (!this.isHost || !state.cardSystem) return;
        const seat = this.session.seatOfClient(from);
        state.cardSystem.onRemotePick(seat, data.id, data.ck);
        break;
      }

      case M.CARD_DONE:
        if (state.cardSystem) state.cardSystem.onRemoteDone(data.ps, data.ck);
        break;

      case M.STAGE:
        if (this.isHost) return;
        this._onStageCommand(data, from);
        break;

      case M.RESULT:
        if (this.isHost) return;
        if (state.onNetResult) state.onNetResult(data);
        break;

      case M.REVIVE: {
        if (!this.isHost) return;
        const seat = this.session.seatOfClient(from);
        if (!state.revive || !state.dead) break;
        // host 自己也停在结算层上（全队是一条血，它跟着一起死的），
        // 先把结算层弹掉回到战场，再执行复活，最后通知 guest 跟上。
        if (this.game.states.current !== state) this.game.states.pop();
        state.dead = false;
        state.revive();
        this.session.broadcast({ t: M.REVIVED, seat }, { critical: true });
        break;
      }

      case M.REVIVED:
        if (this.isHost) return;
        if (state.onNetRevived) state.onNetRevived(data);
        break;

      case M.SCORE: {
        if (!this.isHost) return;
        const seat = this.session.seatOfClient(from);
        if (seat >= 0) this.finalScores.set(seat, data.v | 0);
        break;
      }

      case '_left': {
        if (this.isHost && data.seat >= 0) this.remote.delete(data.seat);
        break;
      }

      default:
        break;
    }
  }

  /** guest：把快照里带的爆点与 Toast 立刻播出来（不走插值延迟，差 140ms 无感） */
  _playFrameFx(msg) {
    const state = this.state;
    if (Array.isArray(msg.e) && state.effects) {
      for (const [x, y, r, color] of msg.e) {
        state.effects.push({ x, y, r, t: 0, dur: 0.35, color });
      }
      if (msg.e.length) this.game.audio.play('boom');
    }
    if (Array.isArray(msg.tx) && state.onNetToast) {
      for (const text of msg.tx) state.onNetToast(text);
    }
  }

  _onStageCommand(data, from) {
    applyStageCommand(this.game, data, from);
  }

  // ---------------- HUD ----------------

  /**
   * 计分板行：[{ seat, name, score, you, host }]，按分数降序。
   * 单机返回空数组（HUD 层据此整块跳过绘制）。
   */
  scoreRows(seatScores) {
    if (!this.online) return [];
    const rows = [];
    for (const m of this.session.roster) {
      rows.push({
        seat: m.seat,
        name: m.name,
        score: (seatScores && seatScores[m.seat]) | 0,
        you: m.seat === this.mySeat,
        host: m.seat === this.session.hostSeat
      });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  /** 右上角一行状态文案 */
  /**
   * 计分板表头文字。要塞进 200 宽的面板里，所以只放最关键的两项
   * （人数看下面的行数就知道了）。
   */
  statusText() {
    if (!this.online) return '';
    if (this.disconnected) return '与主机失联…';
    return `房间 ${this.session.code} · ${this.isHost ? '主机' : '客机'}`;
  }

  get warning() {
    return this.disconnected;
  }

  // ---------------- 结算 ----------------

  /**
   * host：切到下一阶段。下一阶段 state 的 onEnter 里会自己 announceStage，
   * 但那时它的 seatScores 才刚建好 —— 所以这里只负责把「继承分」挂到
   * game.carrySeatScores 上，announce 交给新 state 完成。
   */
  announceNextStage(next) {
    if (!this.online || !this.isHost) return;
    this.game.carrySeatScores = (this.state.seatScores || []).slice();
  }

  /** host：广播结算结果（rows 直接就是计分板，guest 拿来渲染排行） */
  announceResult(opts, rows) {
    if (!this.online || !this.isHost) return;
    this.session.broadcast({
      t: M.RESULT,
      w: opts && opts.win ? 1 : 0,
      rows,
      // 击杀 / 合成 / 投放这些只在 host 的进程里发生过，guest 本地那份是空的。
      // 把整张按座位的表捎下去，各人挑自己那格上报给平台。
      rs: this.game.runStats ? this.game.runStats.encode() : null
    }, { critical: true });
  }

  /** guest：把自己的最终分上报给 host（host 汇总进排行榜） */
  reportScore(score) {
    if (!this.isGuest) return;
    this.session.sendToHost({ t: M.SCORE, v: score | 0 }, { critical: true });
  }

  /** guest：请求全队复活 */
  requestRevive() {
    if (!this.isGuest) return;
    this.session.sendToHost({ t: M.REVIVE }, { critical: true });
  }
}
