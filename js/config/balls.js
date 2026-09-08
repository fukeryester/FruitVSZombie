/**
 * 球体（水果）等级配置 —— 热替换配置中心
 * ------------------------------------------------------------------
 * 修改本文件即可调整每种球体的：名称 / 半径 / 颜色 / 合成得分 / 物理材质 / 贴图名。
 * 贴图文件在 Assets/sprites/{sprite}.png，由 ballRenderer 关闭插值绘制。
 * 无需改动任何游戏逻辑代码。
 *
 * 规则：levels 数组按等级从小到大排列，index 即等级下标（0 起）。
 *       两个相同 index 的球碰撞 → 合成 index+1 的球，得分取新球 score。
 *       最后一级为终极目标（合成后不再继续）。
 *
 * 物理材质（可按等级覆写，不写则用 physicsDefaults）：
 *   restitution  弹性（0~1）
 *   friction     摩擦（0~1，越大越容易停下）
 *   density      密度（影响碰撞动量交换，一般无需改）
 */
export const physicsDefaults = {
  restitution: 0.55, // 弹性系数：手感生命线，推荐 0.15~0.35
  friction: 0.02,    // 摩擦系数
  density: 0.01    // 密度
};

/**
 * 半径基于 **750 设计宽**（main.js DESIGN_WIDTH）。逻辑画布宽 750、高约 1623，
 * 半径整体比 390 时代放大了 750/390 ≈ 1.92 倍，保证水果相对屏幕的占比、
 * 同屏可堆数量（难度）与旧版完全一致。
 */
export const levels = [
  { name: '葡萄',   radius: 42, color: '#a06ee0', score: 1, sprite: 'grape' },
  { name: '樱桃',   radius: 58, color: '#e05464', score: 3, sprite: 'cherry' },
  { name: '橘子',   radius: 77, color: '#f5a623', score: 6, sprite: 'orange' },
  { name: '柠檬',   radius: 100, color: '#f7e05a', score: 10, sprite: 'lemon' },
  { name: '猕猴桃', radius: 125, color: '#7cb342', score: 15, sprite: 'kiwi' },
  { name: '番茄',   radius: 154, color: '#e8503a', score: 21, sprite: 'tomato' },
  { name: '桃子',   radius: 185, color: '#f78fb3', score: 28, sprite: 'peach' },
  { name: '菠萝',   radius: 219, color: '#e8b931', score: 36, sprite: 'pineapple' },
  { name: '椰子',   radius: 256, color: '#8d6e63', score: 45, sprite: 'coconut' },
  { name: '半西瓜', radius: 296, color: '#66bb6a', score: 55, sprite: 'half-watermelon' },
  { name: '大西瓜', radius: 338, color: '#2e9e4f', score: 66, sprite: 'watermelon' }
];

/** 顶部投放生成池：只投前 spawnPoolSize 级（受控随机，防止前期出现超大球） */
export const spawnPoolSize = 5;

/** 每级半径视觉描边 */
export const outlineColor = 'rgba(0,0,0,0.18)';
