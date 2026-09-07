/**
 * 卡牌：穿墙术（持续 3 秒）
 * 接下来的 N 秒内，场上水果之间的物理碰撞被关闭——水果会互相穿透并坠落到底层。
 * 地面与墙壁仍然生效，所以水果不会掉出场景。
 */
import { Card } from './cardBase.js';

export class NoCollideCard extends Card {
  constructor() {
    super();
    // 效果参数（可调）
    this.duration = 3; // 秒
    // 展示元数据
    this.name = '穿墙术';
    this.icon = '🕳';
    this.color = '#7e57c2';
    this.refreshDesc();
  }

  refreshDesc() {
    this.desc = `接下来 ${this.duration} 秒内水果互相穿透，全部坠落到底层`;
  }

  onEnterHand() {
    this.refreshDesc();
  }

  onApply(ctx) {
    ctx.setBodyCollision(false);
    ctx.startTimedEffect({
      dur: this.duration,
      onEnd: () => ctx.setBodyCollision(true)
    });
    ctx.toast(`${this.duration} 秒内水果互相穿透！`);
  }
}
