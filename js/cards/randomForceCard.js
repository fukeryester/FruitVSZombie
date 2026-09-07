/**
 * 卡牌：混乱风暴（持续 3 秒）
 * 接下来的 N 秒内，每秒给场上的每个水果施加一次随机方向的随机力。
 */
import { Card } from './cardBase.js';

export class RandomForceCard extends Card {
  constructor() {
    super();
    // 效果参数（可调）
    this.duration = 3;   // 秒
    this.interval = 1;   // 每 1 秒施加一次
    this.minMag = 260;   // 最小力度（px/s 的速度增量）
    this.maxMag = 620;   // 最大力度
    // 展示元数据
    this.name = '混乱风暴';
    this.icon = '🌪';
    this.color = '#26a69a';
    this.refreshDesc();
  }

  refreshDesc() {
    const times = Math.max(1, Math.round(this.duration / this.interval));
    this.desc = `接下来 ${this.duration} 秒内，每秒给所有水果施加一次随机力（共 ${times} 次）`;
  }

  onEnterHand() {
    this.refreshDesc();
  }

  onApply(ctx) {
    ctx.startTimedEffect({
      dur: this.duration,
      interval: this.interval,
      tick: () => ctx.applyRandomForces(this.minMag, this.maxMag)
    });
    ctx.toast(`${this.duration} 秒内风暴肆虐！`);
  }
}
