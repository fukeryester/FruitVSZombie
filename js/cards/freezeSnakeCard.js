/**
 * 卡牌：冻结蛇（怪蛇阶段）
 * ------------------------------------------------------------------
 * 接下来的数秒内蛇头停止推进（保留极慢速度 snakeFreezeSpeed，避免节奏死板），
 * 给玩家争取火力时间。语义对应 freeze_zombie（冰冻时刻），但目标是蛇而非僵尸。
 */
import { Card } from './cardBase.js';
import { snakeFreezeDuration } from '../config/snake.js';

export class FreezeSnakeCard extends Card {
  constructor() {
    super();
    this.name = '冻结蛇';
    this.icon = '❄';
    this.color = '#5bb8d4';
  }

  onEnterHand() {
    this.desc = `接下来 ${snakeFreezeDuration} 秒内蛇停止推进`;
  }

  onApply(ctx) {
    ctx.freezeSnake(snakeFreezeDuration);
    ctx.toast(`蛇被冻结 ${snakeFreezeDuration} 秒！`);
  }
}