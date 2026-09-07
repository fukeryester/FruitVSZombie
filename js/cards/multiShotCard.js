/**
 * 卡牌：多重射击（僵尸阶段，可叠加）
 * ------------------------------------------------------------------
 * 每次投放发射的水果数量 +1（并排、同等级、同高度下落）。
 * 初始 1 颗，每选一次本卡多一颗，封顶 maxShotSlots 颗。
 */
import { Card } from './cardBase.js';
import { maxShotSlots } from '../config/zombies.js';

export class MultiShotCard extends Card {
  constructor() {
    super();
    this.name = '多重射击';
    this.icon = '🎯';
    this.color = '#4a90d9';
  }

  onEnterHand() {
    this.desc = `每次投放的水果数量 +1（并排同等级下落），最多 ${maxShotSlots} 颗`;
  }

  onApply(ctx) {
    ctx.addShotSlot();
    ctx.toast('多重射击 +1！');
  }
}
