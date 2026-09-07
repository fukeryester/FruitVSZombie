/**
 * 卡牌系统（CardSystem）
 * ------------------------------------------------------------------
 * 由 PlayingState 在 onEnter 时创建，内聚了三选一事件的全部逻辑：
 *   - 触发队列（合成达标 → trigger() 入队，物理稳定后逐次弹出）
 *   - 简单工厂 createCard(id)：按 id 从注册表实例化卡牌对象
 *   - 三选一浮层的打开 / 渲染 / 触摸（选卡期间 playingState 只需查询 active）
 *
 * PlayingState 对外只使用这些 API，不感知卡牌内部实现：
 *   cardSystem.trigger()            合成达标时入队一次选卡事件
 *   cardSystem.update()             每帧驱动（内部决定何时弹出下一张）
 *   cardSystem.active               选卡浮层是否打开（用于暂停物理）
 *   cardSystem.render(ctx)
 *   cardSystem.handleTouch(type, t) → boolean 是否已消费
 *   cardSystem.reset()              清空队列与浮层（复活时调用）
 *
 * ctx 局内上下文门面（由 PlayingState 构造时注入，卡牌效果仅通过它作用）：
 *   getBodies()               → Body[]  场上球的快照
 *   removeBody(b) / resizeBody(b, r)
 *   addScore(n)               加分
 *   addEffect(e)              播放光环特效 {x,y,r,t,dur,color}
 *   toast(msg)                轻提示
 *   playSound(name)           音效
 *   forceDrops(levelIndex, n) 接下来 n 个投放强制为指定等级
 *   isFieldCalm()             场上是否已物理稳定（决定能否弹下一张卡）
 */
import { CardOverlay } from '../ui/cardOverlay.js';
import { cardPool, pickCount } from '../config/cards.js';
import { pickN } from '../core/utils.js';

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

export class CardSystem {
  /**
   * @param {object} game 游戏全局对象（Main 实例）
   * @param {object} ctx  局内上下文门面（结构见文件顶部注释）
   * @param {string[]} [pool] 本状态使用的卡池（默认第一阶段 cardPool；
   *        第二阶段传入 zombieCardPool，只有僵尸阶段专属卡）
   */
  constructor(game, ctx, pool = null) {
    this.game = game;
    this.ctx = ctx;
    this.pool = pool || cardPool;
    this.queue = [];                 // 待弹出的选卡事件队列
    this.overlay = new CardOverlay(game);
  }

  /** 选卡浮层是否打开（打开时局内应暂停物理/投放/越线判定） */
  get active() {
    return this.overlay.visible;
  }

  /** 合成达标 → 入队一次三选一事件（多次触发自动排队） */
  trigger() {
    this.queue.push(Date.now());
  }

  /** 清空队列与浮层（复活 / 重开局时调用） */
  reset() {
    this.queue.length = 0;
    this.overlay.close();
  }

  /** 每帧驱动：物理稳定且队列非空时弹出下一张选卡 */
  update() {
    if (this.overlay.visible || !this.queue.length) return;
    if (!this.ctx.isFieldCalm()) return;
    this.queue.shift();
    const choices = this._pickChoices();
    if (!choices.length) return;
    for (const c of choices) c.onEnterHand();
    this.overlay.open(choices, (card) => {
      card.onApply(this.ctx);
      this.game.audio.play('boom');
      // 队列中还有事件 → 下一帧 update 继续弹（避免重入）
    });
  }

  /** 从卡池随机抽 pickCount 张，经工厂实例化 */
  _pickChoices() {
    return pickN(this.pool, pickCount)
      .map((id) => CardSystem.createCard(id))
      .filter(Boolean);
  }

  /**
   * 直接赋予玩家一张卡（不走三选一浮层）—— 神器拾取等场景使用。
   * @param {string} [id] 指定卡 id；缺省从本状态卡池随机
   * @returns {Card|null} 实际应用的卡牌实例
   */
  grantCard(id = null) {
    const cardId = id || this.pool[Math.floor(Math.random() * this.pool.length)];
    const card = CardSystem.createCard(cardId);
    if (!card) return null;
    card.onEnterHand();
    card.onApply(this.ctx);
    this.game.audio.play('boom');
    return card;
  }

  /**
   * 简单工厂：按 id 创建卡牌对象。
   * 新增卡牌 → 派生类 + registerCard 注册，无需改动本方法。
   */
  static createCard(id) {
    const cls = registry.get(id);
    return cls ? new cls() : null;
  }

  render(ctx) {
    this.overlay.render(ctx);
  }

  handleTouch(type, touch) {
    return this.overlay.handleTouch(type, touch);
  }
}
