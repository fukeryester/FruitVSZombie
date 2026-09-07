/**
 * 第三阶段（水果大战怪蛇）配置 —— 热替换配置中心
 * ------------------------------------------------------------------
 * 所有可调参数集中在这一处：蜿蜒曲线 / 蛇节几何 / 血量梯度 / 移动速度 /
 * 卡牌节点分布。改数值不用动任何逻辑代码。
 *
 * 坐标均为 750 设计宽基准（与 balls.js / physics.js / zombies.js 一致）。
 */
import { GRAVITY } from '../core/physics.js';

// ---------------- 失败阈值 ----------------

/** 顶部阈值线 y 坐标：蛇节爬到这里即败（与 fruitVsZombie 同一位置）。
 *  失败条件改为"任意活蛇节越线"（蛇头只是其中一个会爬到的节）—— 没有反伤，
 *  玩家唯一目标是持续砸蛇节防止任何一节越过阈值线。 */
export const snakeWarnY = 327;

// ---------------- 蛇身几何 ----------------

/**
 * 蛇节半径（设计单位 px，半屏宽 750 设计宽）。
 * 用户口径："至少要比等级 4 水果（半径 125）大"。
 * 这里取 160 —— 比番茄（154）还略大（直径 320 = 屏宽 43%），
 * 视觉上"怪蛇"压迫感强烈，玩家一眼能识别是更硬的目标。
 *
 * 注意：r 越大，相邻节点遮挡越严重；snakeSpacing 需要 < 2r 让蛇身紧密相连；
 *        amp 摆动需要 ≤ (W/2 - r) 避免节点越出屏幕。
 */
export const snakeNodeRadius = 160;

/**
 * 节距 = snakeNodeRadius × 1.5 —— 相邻节点重叠 25%（节点间距 240，节点直径 320 → 80 px 重叠），
 * 蛇身呈"实心肉感"，不像珠子链。300 节 × 240 = 72000 px 弧长。
 */
export const snakeSpacing = snakeNodeRadius * 1.5;

/** 蛇身节点总数（用户口径调整：从 500 → 300 —— 去掉反伤后玩家通关压力大幅降低，
 *  300 节让"砸节速率 vs 蛇头推进"的窗口期更紧，保留"反复攻打同一节"的张力） */
export const snakeNodeCount = 300;

/** 蛇身总弧长（= nodeCount × spacing，供曲线采样和卡牌节点分布用） */
export const snakeTotalLen = snakeNodeCount * snakeSpacing;

// ---------------- 蜿蜒曲线（sine 平滑曲线，8 个弯） ----------------

/** 蜿蜒曲线：从屏幕底部到顶部阈值线，8 个完整周期（= 8 个弯/峰）。 */
export const snakeWaveCount = 8;

/**
 * 蛇头初始 s = 0（蛇头在曲线起点 = 屏幕底部正中央）。
 * ------------------------------------------------------------------
 * 推进方向：s_head += snakeSpeed × dt 不断累加至 snakeTotalLen。
 * 抵线判定：s_head >= snakeTotalLen → 蛇头已穿过阈值线 → 判负。
 * 这样玩家初始看到蛇头贴着屏幕底部，每帧 s_head 推进、蛇头沿曲线
 * 蜿蜒爬升，蛇尾节点逐渐从堆叠的"肉团"里解开，呈"蛇从底层
 * 一节节冒出来向上爬"的视觉过程。
 */
export const snakeHeadStartS = 0;

/**
 * 水平摆幅：底部宽、顶部稍收紧（覆盖大部分屏宽的"铺满"蛇身）。
 * ------------------------------------------------------------------
 * 屏宽 750、单节半径 160 → 摆幅上限须 ≤ (W/2 - r) = (375 - 160) = 215，
 * 否则蛇头最外点会越出右边界。这里取 snakeAmpBottom = 210（留 5 px 余量），
 * 顶部 amp = 210×(1-0.5)=105 ≈ 节点 0.66 倍直径。
 * 用户口径："蜿蜒弯曲的时候都要几乎覆盖整个屏幕宽度"。
 */
export const snakeAmpBottom = 210;
export const snakeAmpTaper = 0.5;
export const snakeAmpTop = snakeAmpBottom * (1 - snakeAmpTaper);

/** 蛇身从屏幕底部（贴地）出发，y 起始 = floorY */
export const snakeStartYOffset = 30;

// ---------------- 蛇的移动 ----------------

/**
 * 蛇头推进速度（px/s，沿曲线弧长）：
 * 当前 snakeTotalLen = 300 × 240 = 72000 px → 72000 / 440 ≈ 164 秒 ≈ 2.7 分钟抵达顶部。
 * 去掉反伤后整体通关时间缩短（不需要再管血量分配），节奏更紧凑。
 */
export const snakeSpeed = 440;

/**
 * freeze_snake 卡：冻结持续秒数。冻结期间蛇头推进速度归零。
 */
export const snakeFreezeDuration = 6;
/** 冻结时的实际速度（不是 0，保留极慢推进避免节奏死板） */
export const snakeFreezeSpeed = 0;

// ---------------- 蛇节血量梯度 ----------------

/**
 * 沿蛇身方向血量线性递增：蛇头最薄、蛇尾最厚。
 * hp[i] = lerp(head, tail, i / (N-1))
 *
 * 用户口径："开始时的尸核我希望 5-10 下才可以砸死，后期的尸核可能要 30+ 下"
 * 这里取 snakeHpHead = 5、snakeHpTail = 30，刚好覆盖"5 下到 30+ 下"区间。
 *
 * 注意：去掉反伤后蛇节 hp 决定"每节需要几击"，5 hp 一击秒杀让通关节奏很快，
 *       玩家主要任务是"砸足够多节防越线"而非"磨血"。
 */
export const snakeHpHead = 5;
export const snakeHpTail = 30;

/**
 * 卡牌节点血量倍数（在基础 hp 上 × [snakeCardHpMulMin, snakeCardHpMulMax] 随机）。
 * 用户口径："血量也会翻 1.5-3 倍左右"
 *
 * 去掉反伤后，卡牌节加厚 = "更难砸死"；玩家遇到卡牌节需要 2-3 击处理，
 *       是节奏中的"小 Boss"概念。
 */
export const snakeCardHpMulMin = 1.5;
export const snakeCardHpMulMax = 3.0;

/** 卡牌节点间隔：每 ~N 节挑一个作为卡牌节点 */
export const snakeCardEvery = 15;

// ---------------- 蛇头抵线警告 ----------------

/**
 * 蛇头接近阈值线时的预警距离：剩余多少 px 时开始闪屏预警。
 * warnY - headY < warnDistance 时屏幕闪红 + Toast 提醒。
 */
export const snakeWarnDistance = 80;

// ---------------- 调试 / 节奏参数 ----------------

/** 调试跳段按钮（有下一阶段 → 直接晋级；最终关 → 跳结算） */
export const DEBUG_SKIP_BTN = { x: 30, y: 1400, w: 220, h: 96 };

// ---------------- 工具函数 ----------------

/**
 * 沿蛇身参数 s (0 ≤ s ≤ totalLen) 求 (x, y)
 * ------------------------------------------------------------------
 * t = s / totalLen：s=0 → t=0（蛇头起步位置 = 屏幕底部）；s=totalLen → t=1
 *   （蛇头已抵线 = 阈值线 y 位置）。
 * 曲线：x = W/2 + amp(t) × sin(phase)
 *       y = bottomY - t × (bottomY - warnY)
 * phase = (1 - t) × 2π × waveCount（t=1 → phase=0 → x=W/2 在中线）
 *
 * s 越界（<0 或 >totalLen）会被 clamp，蛇尾节点会堆叠在曲线起点。
 */
export function snakePathAt(s, screenW, screenH) {
  const t = clamp(s / snakeTotalLen, 0, 1);
  const phase = (1 - t) * Math.PI * 2 * snakeWaveCount;
  const amp = snakeAmpBottom * (1 - snakeAmpTaper * t);
  const cx = screenW / 2;
  const bottomY = screenH - snakeStartYOffset;
  const x = cx + amp * Math.sin(phase);
  const y = bottomY - t * (bottomY - snakeWarnY);
  return [x, y];
}

/**
 * 蛇身总节数下，已存在的卡牌节点 idx 数组（按 ~cardEvery 间距均匀分布）。
 * 第一个卡牌节点 idx = floor(cardEvery/2)，避免蛇头最近节就是卡牌节点（节奏死板）。
 */
export function cardNodeIndices() {
  const out = [];
  const offset = Math.floor(snakeCardEvery / 2);
  for (let i = offset; i < snakeNodeCount; i += snakeCardEvery) out.push(i);
  return out;
}

/** clamp（局部工具，避免循环引用） */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** 重力（蛇节被砸后小弹起用的视觉常量，从 physics 复用） */
export const SNAKE_GRAVITY = GRAVITY;