/**
 * 卡牌：分裂水果（僵尸阶段，可叠加）
 * ------------------------------------------------------------------
 * 接下来的 N 次碰撞中，凡是"砸死僵尸后仍然存活"的水果，在结算完最终半径
 * 与反作用力之后，会在碰撞点分裂出一只等级低一级、半径为低一级标准半径
 * 4/5 的小水果。分裂体受到的反作用力与母体"垂直方向相同、水平方向相反、
 * 大小相等"。最低等级（葡萄）不能再分裂。
 * 重复选卡叠加剩余次数。
 */
import { Card } from './cardBase.js';
import { splitChargesPerCard, splitRadiusFactor } from '../config/zombies.js';

export class SplitFruitCard extends Card {
  constructor() {
    super();
    this.name = '分裂水果';
    this.icon = '🈹';
    this.color = '#e8503a';
  }

  onEnterHand() {
    // 展示当前叠加后的剩余次数（由 ctx 读取，随选卡次数增长）
    this.desc = `接下来 ${splitChargesPerCard} 次碰撞，砸死僵尸后存活的水果会分裂出一只低一级的小水果（可叠加）`;
  }

  onApply(ctx) {
    ctx.addSplitCharges(splitChargesPerCard);
    ctx.toast(`分裂充能 +${splitChargesPerCard}！`);
  }
}
