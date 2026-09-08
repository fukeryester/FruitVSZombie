/**
 * 第二阶段（水果大战僵尸）配置 —— 热替换配置中心
 * ------------------------------------------------------------------
 * 所有可调参数集中在这一处：血量 / 出怪节奏 / 爬升力 / 难度成长曲线 /
 * 碰撞反作用力 / 抽卡与晋级目标。改数值不用动任何逻辑代码。
 *
 * 坐标均为 750 设计宽基准（与 balls.js / physics.js 一致）。
 */
import { GRAVITY } from '../core/physics.js';

/** 玩家最大血量（僵尸越线扣血，归零失败）。
 *  36：怪多但单只弱（越线扣 1~2 血），总血量池抬高以匹配"割草"密度与持久战。 */
export const playerMaxHP = 36;

/** 僵尸爬升总加速度（px/s²，须 > GRAVITY 才有净向上力；净加速度 = 本值 - GRAVITY）。
 *  5120 → 净 120：初始移动进一步放缓（肉鸽割草节奏：数量施压而非单兵速度）。 */
export const zombieClimbAccel = 5080;

/** 僵尸爬升最大速度（px/s，终端速度）。
 *  恒定加速度不封顶会越爬越快（净 80 加速 5 秒即 400px/s），
 *  封顶后怪潮稳定缓慢推进，配合大批量出怪营造割草感。 */
export const zombieMaxClimbSpeed = 210;

/** 出怪间隔（秒）：从 start 随时间线性缩短到 min。 */
export const zombieSpawnIntervalStart = 1.35;
export const zombieSpawnIntervalMin = 0.48;
/** 每过 1 秒间隔缩短多少秒 */
export const zombieSpawnIntervalDecay = 0.02;

/**
 * 出怪波次数量（开局每波 5 只，每 growEvery 秒 +1，封顶 waveMax）。
 * 与"间隔缩短"叠加，越后期同屏压力越大 —— 数量大但强度弱。
 */
export const zombieWaveStart = 5;
export const zombieWaveMax = 12;
export const zombieWaveGrowEvery = 28;

/** 僵尸等级上限随时间成长：初始 maxLevelStart 级，每 growEvery 秒 +1，封顶 maxLevelCap。
 *  初始 0（r 42）且封顶 3（r 100）：单个僵尸强度大幅下调，聚焦割草感。 */
export const zombieMaxLevelStart = 0;
export const zombieMaxLevelCap = 3;
export const zombieMaxLevelGrowEvery = 30;

/** 僵尸等级加权偏置速度（越大高等级越晚出现）：45，配合低封顶保持"弱兵海" */
export const zombieBiasEvery = 45;

/**
 * 方阵僵尸：每波出怪时以 phalanxChance 概率改为刷出一个 x*y 矩阵方阵。
 * 方阵按矩阵摆位出场（仅低等级），出场后逻辑与普通僵尸一致（各跑各的）。
 */
export const phalanxChance = 0.22;
export const phalanxMaxCols = 5;
export const phalanxMaxRows = 4;
export const phalanxLevelMax = 1;

/** 越线伤害 = 僵尸等级 + zombieDamageBase（越大扣越多） */
export const zombieDamageBase = 1;

/** 击杀得分 = 该等级水果配置分 × 倍率 */
export const zombieScoreMul = 10;

/** 每击杀多少个僵尸触发一次三选一抽卡。
 *  12 → 18：大水果分裂后清怪效率暴涨，再按 12 抽卡会让雪球滚得太快
 *  （僵尸越密反而越简单——击杀喂卡、卡又加输出，形成正反馈）。 */
export const zombieCardTriggerCount = 18;

// ---------------- 双线战场：墙 / 神器 / 尸核 ----------------

/**
 * 左半区（3x3 神器格）占屏宽的比例。
 * ------------------------------------------------------------------
 * 必须让"单列内壁净宽"容得下等级1 水果（直径 116），否则大水果分裂出的
 * 小水果一样会被竖隔板卡住、刚出生就被销毁，分裂机制等于白做。
 *   净宽 = ratio × 750 / 3 − wallThickness
 *   0.50 → 125 − 14 = 111  ✗（116 塞不进去）
 *   0.56 → 140 − 14 = 126  ✓（左右各留 5px 余量）
 * 右半区相应变窄（出怪区 330px），僵尸更集中、更好打，与"割草感"一致。
 */
export const arenaLeftRatio = 0.56;

/** 墙体厚度（px，设计单位） */
export const wallThickness = 14;

/**
 * 水果撞竖直墙 → 分裂 / 弹开（**没有任何水果走自毁**）。
 * ------------------------------------------------------------------
 * 背景：后期水果半径远大于格子净宽，撞上竖隔板/中隔墙就被销毁 —— 既浪费
 *       弹药，又永远打不到下层的横墙。
 * 规则：
 *   · 等级 ≥ wallSplitMinLevel（樱桃及以上）→ 分裂成若干颗葡萄，继续往下挖；
 *   · 等级 < wallSplitMinLevel（即最低级的葡萄）→ 只"受到碰撞"被弹开，
 *     保留在场上（可继续参与合成），不掉血、不自毁。
 * 分裂产物：level = wallSplitChildLevel（葡萄）、noMerge = true（禁止再次合成）。
 *           葡萄撞竖直墙本来就只会被弹开，所以产物不需要额外的出生免死期。
 */
export const wallSplitMinLevel = 1;
/** 分裂出的小水果等级（0 = 葡萄，直径 84，格子净宽 126 轻松容纳） */
export const wallSplitChildLevel = 0;
/**
 * 分裂数量 = 水果代码等级 + 本偏移。
 * 玩家口径是 1 起算（葡萄=1 级、樱桃=2 级 …），"分裂成【等级】个"换算到
 * 代码 0 起的 level 就是 level + 1：樱桃→2 颗、橘子→3 颗、柠檬→4 颗 …
 * 这样每颗分裂水果的收益（数量 × 葡萄伤害 210）都高于它自身直砸的伤害
 * （樱桃 290 → 420），分裂永远是正收益。想改回"严格等于代码等级"填 0。
 */
export const wallSplitCountOffset = 1;
/** 分裂产物落在墙两侧相邻格子的中心，这是相对中心的横向随机抖动（px）。
 *  必须远小于格内壁余量（净宽 126 − 直径 116 = 10，单侧 5），否则会贴到隔板。 */
export const wallSplitJitter = 4;
/** 出生时的小幅上抛（px/s）：拉开身位，视觉上更像"炸开" */
export const wallSplitLift = 260;
/** 同侧多只小水果的纵向错位间距（× 半径）；≥ 2.1 可保证下落途中互不接触 */
export const wallSplitStackGap = 2.1;

/**
 * 3x3 神器格的平行血墙（共 4 行 × 3 段 = 12 段，编号墙1~墙12）血量区间。
 * 行 0（墙1-3）在最上方最脆弱，行 3（墙10-12）在最下方最坚固 ——
 * 玩家自上而下逐层"挖掘"逼近尸核。
 */
export const wallHpRanges = [
  [2100, 3300],    // 墙1-3  ×6
  [5700, 6900],    // 墙4-6
  [9000, 12000],   // 墙7-9
  [15000, 18000]   // 墙10-12
];

/** 墙13（网格正下方、尸核舱顶盖，横跨左半区整宽）血量 */
export const wall13Hp = 18000;

/** 尸核血量 / 半径（血红色静态球，不会向上移动） */
export const coreMaxHp = 30000;
export const coreRadius = 62;

/** 水果对墙 / 尸核的伤害 = 水果半径 × 本系数（半径越大伤害越高） */
export const fruitWallDamageMul = 5;

/** 尸核被水果砸中时孵化小僵尸：数量 = 本次伤害 / 每个小僵尸血量 */
export const coreZombieHp = 400;
/** 尸核孵化的小僵尸半径 */
export const coreZombieRadius = 22;

/** 僵尸半径 = 同级水果半径 × 该系数（缩小单兵体积，给数量腾空间） */
export const zombieRadiusMul = 0.75;

// ---------------- 水果（弹药）成长 ----------------

/** 投放等级上限：初始 0~3，每 fruitGrowEvery 秒 +1，封顶 fruitMaxLevelCap */
export const fruitMaxLevelStart = 3;
export const fruitMaxLevelCap = 8;
export const fruitGrowEvery = 30;

/** 水果等级加权偏置速度（越大高等级越晚出现）：60 → 90，高级水果更难出（保留一定合成空间） */
export const fruitBiasEvery = 90;

/**
 * 随时间偏向高等级的加权随机等级下标。
 * 权重 = "低位基础权重" + "随时间增长的高位偏置"：
 *   w[i] = (max - i + 1) + i * (elapsed / biasEvery)
 * @param {number} max    当前等级上限（含）
 * @param {number} elapsed 已进行秒数
 * @param {number} biasEvery 偏置速度（越小高等级来得越快）
 */
export function timedWeightedLevelIndex(max, elapsed, biasEvery) {
  const w = [];
  for (let i = 0; i <= max; i++) w.push(Math.max(0.5, (max - i + 1) + i * (elapsed / biasEvery)));
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) return i;
  }
  return 0;
}

// ---------------- 碰撞结算的反作用力（设计单位 px/s） ----------------

/** 水果砸死僵尸后被弹起的向上速度 */
export const fruitBounceSpeed = 900;
/** 僵尸没被砸死时被砸回的向下速度（1200：即使杀不死也能把僵尸砸回很远处争取时间） */
export const zombieKnockSpeed = 1200;
/** 幸存者受到的随机横向扰动幅度（± 该值） */
export const survivorJitter = 380;

/** 半径低于该值的幸存者视为"半径归零"直接消失 */
export const minSurviveRadius = 20;

/** 分裂水果：每次选卡叠加的剩余分裂次数 */
export const splitChargesPerCard = 5;
/** 分裂出的小水果半径 = 低一级标准半径 × 该系数 */
export const splitRadiusFactor = 0.8;

/** 多重射击槽位上限 */
export const maxShotSlots = 5;

/** 冰冻时刻：僵尸爬升净加速度乘数与持续秒数 */
export const freezeClimbMul = 0.4;
export const freezeDuration = 6;

/**
 * 僵尸当前实际爬升加速度（受冰冻卡影响）：
 * 对"净向上加速度"（zombieClimbAccel - GRAVITY）施加乘数，再叠回重力。
 */
export function effectiveClimbAccel(climbMul) {
  return GRAVITY + (zombieClimbAccel - GRAVITY) * climbMul;
}
