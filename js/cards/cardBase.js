/**
 * 卡牌基类（Card）
 * ------------------------------------------------------------------
 * 所有具体卡牌继承本类。扩展一张新卡牌只需要：
 *   1. 新建派生类文件，继承 Card；
 *   2. 构造函数里设置展示元数据（name / desc / icon / color）；
 *   3. 实现虚函数 onApply(ctx) 写效果逻辑；
 *   4. 在 js/cards/index.js 中 import 并调用 registerCard(id, 类)。
 *
 * onApply 的 ctx 是局内上下文门面（由 PlayingState 提供给 CardSystem，
 * 具体结构见 js/cards/cardSystem.js 顶部注释）。卡牌只通过 ctx 门面
 * 影响游戏，不直接耦合 PlayingState。
 */
export class Card {
  constructor() {
    // ---- 展示元数据（派生类在构造函数中覆盖）----
    this.name = '未命名卡牌';
    this.desc = '';
    this.icon = '❓';
    this.color = '#999999';
  }

  /**
   * 虚函数：卡牌被玩家选中后应用效果。
   * @param {object} ctx 局内上下文门面
   */
  onApply(ctx) {}

  // ---- 可选虚函数：预留扩展点 ----

  /** 虚函数（可选）：卡牌进入三选一候选时的钩子（如动态刷新 desc） */
  onEnterHand() {}
}
