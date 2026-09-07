/**
 * 卡牌：橘子雨（buff）
 * 接下来落下的 dropCount 个水果固定为 levelIndex 等级。
 */
import { Card } from './cardBase.js';
import { levels } from '../config/balls.js';

export class ForceLevelCard extends Card {
  constructor() {
    super();
    // 效果参数（可调）
    this.dropCount = 5;
    this.levelIndex = 2; // 橘子
    // 展示元数据
    this.name = '橘子雨';
    this.icon = '🍊';
    this.color = '#f5a623';
    this.refreshDesc();
  }

  /** 参数变化时刷新描述（desc 跟随参数动态生成） */
  refreshDesc() {
    this.desc = `接下来落下的 ${this.dropCount} 个水果都是${levels[this.levelIndex].name}`;
  }

  onEnterHand() {
    this.refreshDesc(); // 进入候选时描述始终与参数一致
  }

  onApply(ctx) {
    ctx.forceDrops(this.levelIndex, this.dropCount);
    ctx.toast(`接下来 ${this.dropCount} 个都是${levels[this.levelIndex].name}`);
  }
}
