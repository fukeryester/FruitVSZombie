/**
 * 卡牌：缩小术（一次性）
 * 场上所有水果半径减少 1/3（但不低于低一级半径的 0.7 倍）。
 */
import { Card } from './cardBase.js';
import { levels } from '../config/balls.js';

export class ShrinkAllCard extends Card {
  constructor() {
    super();
    this.name = '缩小术';
    this.desc = '场上所有水果的半径减少 1/3';
    this.icon = '⚗';
    this.color = '#4a90d9';
  }

  onApply(ctx) {
    for (const b of ctx.getBodies()) {
      const minR = levels[Math.max(0, b.level - 1)].radius;
      ctx.resizeBody(b, Math.max(minR * 0.7, b.r * (2 / 3)));
    }
    ctx.toast('所有水果缩小了！');
  }
}
