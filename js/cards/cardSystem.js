/**
 * 卡牌系统（CardSystem）
 * ------------------------------------------------------------------
 * 由局内 state 在 onEnter 时创建，内聚了三选一事件的全部逻辑：
 *   - 触发队列（合成/击杀达标 → trigger() 入队，物理稳定后逐次弹出）
 *   - 简单工厂 createCard(id)：按 id 从注册表实例化卡牌对象
 *   - 三选一浮层的打开 / 渲染 / 触摸（选卡期间 state 只需查询 active）
 *
 * 联机（共享选卡）
 * ------------------------------------------------------------------
 * 传入 sync（StageSync）后，一次选卡就变成一次**全房间投票**：
 *   1. host 摇出三张候选 → 广播 CARD_OPEN（含候选与倒计时秒数）；
 *   2. **所有玩家同时暂停**并弹出同样的三张牌，各选各的；
 *   3. 全员选完、或 CARD_PICK_SECONDS 秒到点，host 收口：
 *      没选的人由 host **随机代选**一张；
 *   4. host 广播 CARD_DONE，并把**每个人选中的卡的效果依次全部应用**到
 *      这一个共享世界上 —— 这就是「卡牌效果共享」：4 个人选 4 张，
 *      全队一次吃满 4 份增益。
 * guest 不执行任何效果（host 权威），只负责显示与投票。
 *
 * state 对外只使用这些 API：
 *   cardSystem.trigger()            达标时入队一次选卡事件
 *   cardSystem.tick(dt)             每帧驱动（含投票倒计时，暂停期间也要调）
 *   cardSystem.update()             物理稳定时驱动出牌（暂停期间不调）
 *   cardSystem.active               选卡浮层是否打开（用于暂停物理）
 *   cardSystem.render(ctx) / handleTouch(type, t) / reset()
 *   cardSystem.applyingSeat         正在结算哪一位玩家选的卡（加分归属）
 *
 * ctx 局内上下文门面（由 state 构造时注入，卡牌效果仅通过它作用）：
 *   getBodies() / removeBody(b) / resizeBody(b, r) / addScore(n) /
 *   addEffect(e) / toast(msg) / playSound(name) / forceDrops(lv, n) /
 *   isFieldCalm() / startTimedEffect(opts) / setBodyCollision(on) /
 *   applyRandomForces(min, max)  以及僵尸阶段的 addSplitCharges /
 *   addShotSlot / freezeZombies
 */
import { CardOverlay } from '../ui/cardOverlay.js';
import { cardPool, pickCount } from '../config/cards.js';
import { CARD_PICK_SECONDS } from '../config/net.js';
import { M } from '../net/protocol.js';
import { pickN } from '../core/utils.js';
import { showToast } from '../ui/widgets.js';

// ---- 简单工厂的注册表 ----
const registry = new Map();

/**
 * 注册卡牌类型（各卡牌文件在模块加载时自注册，见 js/cards/index.js）。
 * @param {string} id 卡牌唯一 id
 * @param {Function} cls 继承自 Card 的派生类
 */
export function registerCard(id, cls) {
  registry.set(id, cls);
}

/** host 迟迟不收口时 guest 自行放行的宽限秒数（防止卡死在暂停画面） */
const GUEST_GRACE_SECONDS = 4;

export class CardSystem {
  /**
   * @param {object} game 游戏全局对象（Main 实例）
   * @param {object} ctx  局内上下文门面（结构见文件顶部注释）
   * @param {string[]} [pool] 本状态使用的卡池（默认第一阶段 cardPool）
   * @param {object} [sync] StageSync；为空即单机，选卡还是老样子
   */
  constructor(game, ctx, pool = null, sync = null) {
    this.game = game;
    this.ctx = ctx;
    this.pool = pool || cardPool;
    this.sync = sync;
    this.queue = [];                 // 待弹出的选卡事件队列
    this.overlay = new CardOverlay(game);
    /** 当前投票：{ id, ids, deadline, picks: Map(seat → {id, auto}) } */
    this.vote = null;
    this._voteSeq = 0;
    /** 正在结算谁选的卡（供 ctx.addScore 归属得分） */
    this.applyingSeat = 0;
  }

  /** 选卡浮层是否打开（打开时局内应暂停物理/投放/越线判定） */
  get active() {
    return this.overlay.visible;
  }

  get online() {
    return !!(this.sync && this.sync.online);
  }

  get isHost() {
    return !this.sync || this.sync.isHost;
  }

  get mySeat() {
    return this.sync ? this.sync.mySeat : 0;
  }

  /** 达标 → 入队一次三选一事件（多次触发自动排队；只有 host 会真正出牌） */
  trigger() {
    if (!this.isHost) return;
    this.queue.push(Date.now());
  }

  /** 清空队列与浮层（复活 / 重开局时调用） */
  reset() {
    this.queue.length = 0;
    this.vote = null;
    this.overlay.close();
  }

  /**
   * 每帧驱动（**选卡暂停期间也必须调用**）：推进投票倒计时。
   * @param {number} dt
   */
  tick(dt) {
    if (!this.vote) return;
    const now = Date.now();
    if (this.isHost) {
      if (this._allPicked() || now >= this.vote.deadline) this._finishVote();
    } else if (now >= this.vote.deadline + GUEST_GRACE_SECONDS * 1000) {
      // host 迟迟不下发结果（丢包/卡顿）：自己放行，等下一帧快照对齐世界
      this.vote = null;
      this.overlay.close();
    }
  }

  /** 物理稳定且队列非空时弹出下一张选卡（暂停期间 state 不会调到这里） */
  update() {
    if (this.overlay.visible || this.vote || !this.queue.length) return;
    if (!this.isHost) return;
    if (!this.ctx.isFieldCalm()) return;
    this.queue.shift();
    const ids = this._pickChoiceIds();
    if (!ids.length) return;
    this._startVote(ids);
  }

  // ---------------- 投票流程 ----------------

  _pickChoiceIds() {
    return pickN(this.pool, pickCount);
  }

  _seats() {
    return this.online ? this.sync.seats : [this.mySeat];
  }

  _allPicked() {
    if (!this.vote) return false;
    for (const seat of this._seats()) {
      if (!this.vote.picks.has(seat)) return false;
    }
    return true;
  }

  /** host：开一次投票 */
  _startVote(ids) {
    const seconds = this.online ? CARD_PICK_SECONDS : 0;
    this.vote = {
      id: ++this._voteSeq,
      ids,
      deadline: Date.now() + (seconds || 9999) * 1000,
      picks: new Map()
    };
    if (this.online) {
      this.sync.session.broadcast({
        t: M.CARD_OPEN, ids, dl: seconds, ck: this.vote.id
      }, { critical: true });
    }
    this._openOverlay(ids, seconds);
  }

  /** guest：收到 host 的开牌通知 */
  onRemoteOpen(ids, seconds, voteId) {
    if (this.isHost) return;
    if (!Array.isArray(ids) || !ids.length) return;
    if (this.vote && this.vote.id === voteId) return;
    this.vote = {
      id: voteId,
      ids,
      deadline: Date.now() + (seconds || CARD_PICK_SECONDS) * 1000,
      picks: new Map()
    };
    this._openOverlay(ids, seconds || CARD_PICK_SECONDS);
  }

  _openOverlay(ids, seconds) {
    const cards = ids.map((id) => CardSystem.createCard(id)).filter(Boolean);
    // 卡池里写了未注册的 id：直接放弃这次选卡，否则会弹出一张牌都没有的
    // 空浮层，而游戏此时是暂停的 —— 那就死锁了。
    if (!cards.length) {
      console.warn('[card] 卡池 id 全部未注册，跳过本次选卡', ids);
      this.vote = null;
      return;
    }
    for (const c of cards) c.onEnterHand();
    this.overlay.open(cards, (card) => this._onLocalPick(card), {
      deadline: seconds ? this.vote.deadline : 0,
      seats: this._seats().map((seat) => ({
        seat,
        name: this.sync ? this.sync.nameOf(seat) : '我',
        mine: seat === this.mySeat
      })),
      online: this.online
    });
  }

  /** 本机玩家点了一张牌 */
  _onLocalPick(card) {
    if (!this.vote) return;
    const id = this._idOfCard(card);
    if (!this.online) {
      // 单机：立刻结算，行为与改造前完全一致
      this._applyOne(id, this.mySeat);
      this.vote = null;
      this.overlay.close();
      return;
    }
    const voteId = this.vote.id;
    this.overlay.lockMyPick(card);
    this._recordPick(this.mySeat, id, false);
    if (this.isHost) {
      if (this._allPicked()) this._finishVote();
    } else {
      this.sync.session.sendToHost({ t: M.CARD_PICK, id, ck: voteId }, { critical: true });
    }
  }

  /** host：收到某位 guest 的选择 */
  onRemotePick(seat, id, voteId) {
    if (!this.isHost || !this.vote) return;
    if (voteId !== this.vote.id) return;
    if (seat < 0 || !this.vote.ids.includes(id)) return;
    this._recordPick(seat, id, false);
    if (this._allPicked()) this._finishVote();
  }

  _recordPick(seat, id, auto) {
    if (!this.vote || this.vote.picks.has(seat)) return;
    this.vote.picks.set(seat, { id, auto });
    this.overlay.markPicked(seat);
  }

  /**
   * host：随快照捎带的投票进度 `[voteId, ...已选座位]`。
   * 单独发一条报文也行，但选卡暂停期间快照本来就在飞，搭个便车更省配额。
   */
  voteProgress() {
    if (!this.online || !this.isHost || !this.vote) return null;
    return [this.vote.id, ...this.vote.picks.keys()];
  }

  /** guest：把 host 的投票进度画到浮层上（谁已经选好了） */
  onVoteProgress(cv) {
    if (this.isHost || !Array.isArray(cv) || !this.vote) return;
    if (cv[0] !== this.vote.id) return;
    for (let i = 1; i < cv.length; i++) this.overlay.markPicked(cv[i]);
  }

  /** host：收口 —— 未选的人随机代选，广播结果，然后把所有人的效果都应用一遍 */
  _finishVote() {
    if (!this.vote) return;
    const vote = this.vote;
    this.vote = null;
    for (const seat of this._seats()) {
      if (vote.picks.has(seat)) continue;
      const id = vote.ids[Math.floor(Math.random() * vote.ids.length)];
      vote.picks.set(seat, { id, auto: true });
    }
    const rows = Array.from(vote.picks.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([seat, p]) => [seat, p.id, p.auto ? 1 : 0]);
    if (this.online) {
      this.sync.session.broadcast({ t: M.CARD_DONE, ck: vote.id, ps: rows }, { critical: true });
    }
    this.overlay.close();
    this._applyAll(rows);
  }

  /** guest：收到最终结果，只做展示 */
  onRemoteDone(rows, voteId) {
    if (this.isHost) return;
    if (this.vote && this.vote.id !== voteId) return;
    this.vote = null;
    this.overlay.close();
    this._announce(rows);
  }

  /** host：依次应用每位玩家选中的卡（效果共享给全队） */
  _applyAll(rows) {
    this._announce(rows);
    for (const [seat, id] of rows) {
      this._applyOne(id, seat);
    }
    this.game.audio.play('boom');
  }

  _applyOne(id, seat) {
    const card = CardSystem.createCard(id);
    if (!card) return null;
    // 这里是「某个座位选定的卡真正生效」的唯一入口：单机走一次、host 替全队各走
    // 一次、guest 不走（它只收 CARD_DONE 做展示）。和击杀 / 合成一样由 host 记账。
    if (this.game.runStats) this.game.runStats.add(seat, 'cards', 1);
    card.onEnterHand();
    this.applyingSeat = seat;
    try {
      card.onApply(this.ctx);
    } finally {
      this.applyingSeat = this.mySeat;
    }
    return card;
  }

  /** 弹一条「谁选了什么」的汇总提示 */
  _announce(rows) {
    if (!this.online || !rows || !rows.length) return;
    const parts = rows.map(([seat, id, auto]) => {
      const card = CardSystem.createCard(id);
      const name = card ? card.name : id;
      return `${this.sync.nameOf(seat)}${auto ? '(随机)' : ''}：${name}`;
    });
    const text = `卡牌共享 → ${parts.join('，')}`;
    showToast(text, 2.6);
    if (this.sync && this.sync.isHost) this.sync.pushToast(text);
  }

  _idOfCard(card) {
    return (card && card.cardId) || '';
  }

  /**
   * 直接赋予一张卡（不走三选一浮层）—— 神器拾取等场景使用。
   * 联机时同样由 host 调用，效果作用于共享世界，得分归拾取者。
   * @param {string} [id] 指定卡 id；缺省从本状态卡池随机
   * @param {number} [seat] 得分归属座位
   * @returns {Card|null}
   */
  grantCard(id = null, seat = null) {
    if (!this.isHost) return null;
    const cardId = id || this.pool[Math.floor(Math.random() * this.pool.length)];
    const card = this._applyOne(cardId, seat == null ? this.mySeat : seat);
    if (card) this.game.audio.play('boom');
    return card;
  }

  /**
   * 简单工厂：按 id 创建卡牌对象。
   * 新增卡牌 → 派生类 + registerCard 注册，无需改动本方法。
   */
  static createCard(id) {
    const cls = registry.get(id);
    if (!cls) return null;
    const card = new cls();
    card.cardId = id; // 反查用（选卡投票要把玩家点中的实例还原成 id 发出去）
    return card;
  }

  render(ctx) {
    this.overlay.render(ctx);
  }

  handleTouch(type, touch) {
    return this.overlay.handleTouch(type, touch);
  }
}
