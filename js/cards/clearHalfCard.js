/**
 * 卡牌：大丰收（一次性）
 * 随机消除场上一半水果，并获得它们分数总和。
 * 注意：场上当前最高等级的水果不参与消除。
 */
import { Card } from './cardBase.js';
import { levels } from '../config/balls.js';
import { pickHalfExcludingMax } from '../core/utils.js';

export class ClearHalfCard extends Card {
  constructor() {
    super();
    this.name = '大丰收';
    this.desc = '随机消除场上一半水果（最高等级除外），并获得它们分数总和';
    this.icon = '✂';
    this.color = '#e8503a';
  }

  onApply(ctx) {
    const bodies = ctx.getBodies();
    if (!bodies.length) return;
    const victims = pickHalfExcludingMax(bodies);
    if (!victims.length) {
      ctx.toast('场上只剩最高级水果，无法消除');
      return;
    }
    let gain = 0;
    for (const v of victims) {
      gain += levels[v.level].score;
      ctx.addEffect({ x: v.x, y: v.y, r: v.r, t: 0, dur: 0.3, color: '#ffffff' });
      ctx.removeBody(v);
    }
    ctx.addScore(gain);
    ctx.toast(`消除 ${victims.length} 个水果 +${gain} 分`);
  }
}
