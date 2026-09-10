/**
 * 联机配置 —— 热替换配置中心
 * ------------------------------------------------------------------
 * 同步模型：**状态同步 + 主机权威**。
 *   · 房间内 seat 最小（房主）的那台机器跑完整物理，称为 host；
 *   · 其余玩家（guest）不跑物理，只上报"投射口位置 / 投放 / 选卡"三种输入，
 *     并把收到的快照按 INTERP_DELAY_MS 的延迟做 lerp 插值后渲染。
 *
 * 服务端只做房间与消息转发（见 GameHub /api/v1/rooms 与 /ws/rooms），
 * 不参与任何玩法计算，因此所有判定都在 host 上完成。
 *
 * 平台限制（必须遵守，否则会收到「发送过于频繁」/「消息过大」）：
 *   · 每连接每秒约 20 条玩法消息；
 *   · 单包最大 8 KB。
 * 下面的频率与体积上限都留了安全余量。
 */

/** 房间人数上限（服务端允许 2–8，本作按需求固定 4） */
export const MAX_PLAYERS = 4;

/** host 广播世界快照的频率（次/秒） */
export const SNAPSHOT_HZ = 10;

/** guest 上报输入的频率（次/秒） */
export const INPUT_HZ = 12;

/**
 * 插值延迟（毫秒）：guest 渲染的是「现在 - 该延迟」时刻的世界。
 * 必须 ≥ 一个快照间隔（1000/SNAPSHOT_HZ = 100ms），否则会频繁插值到未来
 * 而出现抖动；留 40ms 余量吸收网络抖动。
 */
export const INTERP_DELAY_MS = 140;

/** 快照缓冲最多保留多少帧（超过丢弃最旧的） */
export const SNAPSHOT_BUFFER = 8;

/** 选卡阶段的最长等待秒数：到点仍未选的玩家由 host 随机代选 */
export const CARD_PICK_SECONDS = 5;

/** 单条消息的字节安全上限（服务端硬上限 8192） */
export const MAX_PACKET_BYTES = 7400;

/** 每秒最多发送多少条消息（服务端约 20，留余量） */
export const SEND_BUDGET_PER_SEC = 17;

/** 心跳间隔（毫秒）：文档建议 20–30 秒 ping 一次 */
export const PING_INTERVAL_MS = 22000;

/** 多久收不到 host 快照就判定为掉线（毫秒） */
export const HOST_TIMEOUT_MS = 12000;

/**
 * 同屏僵尸硬上限。
 * ------------------------------------------------------------------
 * 联机把出怪量按人数放大后，尸核孵化 + 方阵叠加可能瞬间刷出上百只，
 * 既拖慢 host 物理，也会把快照撑破 8 KB。到达上限后暂停出怪（尸核孵化
 * 同样受限），玩家清完场自然恢复。
 */
export const maxZombiesOnField = 90;

/**
 * 难度随人数放大的系数（n = 房间内玩家数，单人时全部为 1，行为与单机完全一致）。
 * 目标：人均投入的操作量与单机持平 —— 火力 ×n，血条/目标也 ×n。
 */
/** 阶段晋级分数目标 */
export const teamGoalScale = (n) => n;
/** 尸核血量 */
export const teamCoreHpScale = (n) => n;
/** 共享血量池（僵尸越线扣的是全队公共血） */
export const teamHpScale = (n) => n;
/** 每波出怪数量（略低于线性，避免同屏糊成一片） */
export const teamWaveScale = (n) => 1 + 0.6 * (n - 1);

/** 每个座位的代表色（HUD 名牌、投射口指示线） */
export const SEAT_COLORS = ['#ffd24a', '#4ac7ff', '#8ee66f', '#ff8ab0'];

/** 取座位色（越界回退到第一个） */
export function seatColor(seat) {
  return SEAT_COLORS[((seat | 0) % SEAT_COLORS.length + SEAT_COLORS.length) % SEAT_COLORS.length];
}
