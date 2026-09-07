/**
 * 三选一选卡事件 —— 卡池配置（热替换）
 * ------------------------------------------------------------------
 * cardPool 中列出可被抽到的卡牌 id（对应 js/cards/ 下已注册的派生类），
 * 每次触发选卡时随机不重复抽取 pickCount 张供玩家选择。
 *
 * 触发条件：每完成 cardTriggerCount 次合成行为触发一次。
 * 用 let 导出并提供 setter，支持"局内热更新"——运行中调用
 * setCardTriggerCount(n) 即可立即生效（进度条 UI 与触发逻辑每帧
 * 读取实时值，自动跟随，无需重开对局）。
 *
 * 卡牌的展示（名称/描述/图标/颜色）与效果逻辑都在各自的派生类中：
 *   js/cards/clearHalfCard.js   大丰收：随机消除一半水果并得分（最高等级不参与）
 *   js/cards/shrinkAllCard.js   缩小术：全场水果半径 -1/3
 *   js/cards/forceLevelCard.js  橘子雨：接下来 5 个投放固定为橘子
 *   js/cards/noCollideCard.js   穿墙术：3 秒内水果互相穿透、坠落到底层
 *   js/cards/randomForceCard.js 混乱风暴：3 秒内每秒给所有水果施加随机力
 */
export const pickCount = 3;

export const cardPool = [
  'clear_half',
  'shrink_all',
  'force_level',
  'no_collide',
  'random_force'
];

/**
 * 第二阶段（水果大战僵尸）专属卡池：
 *   js/cards/splitFruitCard.js   分裂水果：碰撞后存活的水果分裂出低一级小水果（可叠加）
 *   js/cards/multiShotCard.js    多重射击：每次投放 +1 颗并排同等级水果
 *   js/cards/freezeZombieCard.js 冰冻时刻：6 秒内僵尸爬升速度大幅减慢
 */
export const zombieCardPool = [
  'split_fruit',
  'multi_shot',
  'freeze_zombie'
];

/**
 * 第三阶段（水果大战怪蛇）专属卡池 —— 复用第二阶段 + 新增 freeze_snake + 复用第一阶段：
 *   split_fruit, multi_shot  复用僵尸阶段（蛇节砸破后分裂小水果；并排多颗投放）
 *   freeze_snake              新卡（冻结蛇 6 秒，替代 freeze_zombie 因为这里没僵尸）
 *   clear_half, shrink_all, force_level, no_collide, random_force  复用第一阶段卡池
 */
export const snakeCardPool = [
  'split_fruit',
  'multi_shot',
  'freeze_snake',
  'clear_half',
  'shrink_all',
  'force_level',
  'no_collide',
  'random_force'
];

/** 三选一事件触发条件：每完成 N 次合成触发一次 */
export let cardTriggerCount = 10;

/** 局内热更新触发阈值（进度条与触发逻辑实时跟随） */
export function setCardTriggerCount(n) {
  cardTriggerCount = Math.max(1, Math.floor(n) || 1);
}
