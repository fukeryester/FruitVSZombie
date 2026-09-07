/**
 * 局内"等级"系统 —— **每阶段独立**的玩家等级。
 * ------------------------------------------------------------------
 * 背景：两个局内阶段（fruitMerge / fruitVsZombie）各自维护一份等级，初始 1，
 *       进入阶段时 onEnter → resetPlayerLevel() 重置回 1；触发抽卡后 +1。
 *       下一次抽卡阈值 = 基础阈值 + (等级-1) × 步长：等级越高，攒齐下一次
 *       抽卡所需的事件越多（合成次数 / 击杀数）。
 *
 * 设计要点：
 *   · 等级挂在 game.playerLevel 上，每个阶段 onEnter 重置为 1；
 *   · 两阶段**只共享分数、不共享等级** —— 让玩家在每个阶段都从 Lv.1 起手，
 *     避免把第一阶段的成长雪球带到第二阶段；
 *   · UI 在两个阶段的左上角统一绘制 Lv.X 徽标（升级时短暂闪动）。
 */
export const playerLevelStart = 1;

/**
 * 抽卡阈值表（每个阶段独立）：
 *   基础阈值（等级 1 时使用）+ (playerLevel - 1) × 步长 = 当前阈值
 * 步长越大后期越苛刻；步长 0 表示阈值恒定（不推荐）。
 */
export const cardTriggerConfig = {
  fruitMerge:    { base: 10, step: 2, eventLabel: '合成' },
  fruitVsZombie: { base: 18, step: 2, eventLabel: '击杀' },
  fruitVsSnake:  { base: 25, step: 3, eventLabel: '砸节' }
};

/**
 * 计算"再做几次事件会触发下一次抽卡"。
 * @param {'fruitMerge'|'fruitVsZombie'|'fruitVsSnake'} stageId
 * @param {number} level  当前 game.playerLevel（≥1）
 * @returns {number}
 */
export function getCardTriggerCount(stageId, level) {
  const cfg = cardTriggerConfig[stageId];
  if (!cfg) {
    throw new Error(`getCardTriggerCount: 未注册的 stageId="${stageId}"（请在 cardTriggerConfig 里登记）`);
  }
  const lv = Math.max(1, level | 0);
  return cfg.base + (lv - 1) * cfg.step;
}

/** 重置等级为 playerLevelStart（在每个 state 的 onEnter 调用） */
export function resetPlayerLevel() {
  return playerLevelStart;
}