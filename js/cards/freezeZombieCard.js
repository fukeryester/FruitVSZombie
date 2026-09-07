/**
 * 卡牌：冰冻时刻（僵尸阶段）
 * ------------------------------------------------------------------
 * 接下来的数秒内，所有僵尸的向上爬升速度大幅减慢（净向上加速度乘以
 * freezeClimbMul），新刷出的僵尸同样受影响。给玩家争取火力时间。
 */
import { Card } from './cardBase.js';
import { freezeDuration } from '../config/zombies.js';

export class FreezeZombieCard extends Card {
  constructor() {
    super();
    this.name = '冰冻时刻';
    this.icon = '❄';
    this.color = '#5bb8d4';
  }

  onEnterHand() {
    this.desc = `接下来 ${freezeDuration} 秒内僵尸爬升速度大幅减慢`;
  }

  onApply(ctx) {
    ctx.freezeZombies(freezeDuration);
    ctx.toast(`僵尸被冻结 ${freezeDuration} 秒！`);
  }
}
