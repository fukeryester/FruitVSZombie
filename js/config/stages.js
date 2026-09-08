/**
 * 阶段（关卡）目标配置 —— 热替换
 * ------------------------------------------------------------------
 * 局内顶部进度条展示"分数进度：score / stageScoreGoal"，
 * 条形几何中心处显示与"进入下一阶段"所需分数相关的提示文案。
 *
 * 用 let 导出并提供 setter，支持局内热更新：运行中调用
 * setStageScoreGoal(n) 立即生效，进度条与文案每帧读取实时值。
 */

/**
 * 线性关卡流程（唯一的关卡顺序声明处）
 * ------------------------------------------------------------------
 * 大厅 → fruitMerge（水果合成）→ fruitVsZombie（水果大战僵尸）→ 结算
 * 后续新增阶段只需：
 *   1. 在此数组追加阶段 id；
 *   2. 在 main.js 的 stageFactories 里补一个工厂。
 * 流程末端之外的规则由 main.createNextStageState 统一处理：
 * 当前阶段已是最后一关 → 通关后直接进入结算（ResultState）。
 */
export const STAGE_IDS = ['fruitMerge', 'fruitVsZombie'];

/** 最终阶段（无后续 state）达成目标后，延迟多少秒进入结算（横幅倒计时） */
export const FINAL_CLEAR_DELAY = 3;

export let stageScoreGoal = 1000;

/** 局内热更新阶段目标分数（进度条实时跟随） */
export function setStageScoreGoal(n) {
  stageScoreGoal = Math.max(1, Math.floor(n) || 1);
}

/**
 * 进度条中心文案：简洁提示"达到多少分可进入下一阶段"
 * @param {number} score 当前分数
 * @param {number} goal  阶段目标分数
 */
export function stageTip(score, goal) {
  if (score >= goal) return `下一阶段已达成（${goal} 分）`;
  return `再得 ${goal - score} 分进入下一阶段`;
}
