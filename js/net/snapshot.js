/**
 * 世界快照的编解码与插值
 * ------------------------------------------------------------------
 * host 每 1/SNAPSHOT_HZ 秒把全场刚体（水果 / 僵尸 / 尸核 / 神器）、四个投射口
 * 和阶段自有字段打包成一条报文广播；guest 收下后放进环形缓冲，渲染时取
 * 「现在 - INTERP_DELAY_MS」时刻，在相邻两帧之间做 **lerp** 得到平滑位置。
 *
 * 为什么按「收到的本地时间」而不是 host 时间戳插值：
 *   两端时钟没有同步，任何基于对端时间戳的推算都要先做时钟偏移估计；
 *   而中转服务器的转发延迟相对稳定，用本地收包时刻当时间轴，配合一个
 *   固定的插值延迟，就足以消除 10Hz 快照的台阶感，实现上也简单得多。
 *
 * 刚体编码为一维数字数组（每 6 个一组）：
 *   [ nid, x, y, r, level, kind, ... ]
 * 相比对象数组能省掉全部键名，上百个刚体时体积差出好几倍。
 * 投射口同理：[ seat, x, level, ready, ... ]
 */
import { INTERP_DELAY_MS, SNAPSHOT_BUFFER } from '../config/net.js';
import { kindOf, applyKind } from './protocol.js';

const BODY_STRIDE = 6;
const LAUNCH_STRIDE = 5;

/** 打包刚体列表（跳过已标记 dead 的） */
export function encodeBodies(bodies) {
  const out = [];
  for (const b of bodies) {
    if (b.dead) continue;
    out.push(
      b.nid | 0,
      Math.round(b.x),
      Math.round(b.y),
      Math.round(b.r),
      b.level | 0,
      kindOf(b)
    );
  }
  return out;
}

/** 解包刚体列表 → Map(nid → 渲染用的假刚体) */
export function decodeBodies(flat) {
  const map = new Map();
  if (!flat) return map;
  for (let i = 0; i + BODY_STRIDE <= flat.length; i += BODY_STRIDE) {
    const nid = flat[i];
    const body = applyKind({
      nid,
      x: flat[i + 1],
      y: flat[i + 2],
      r: flat[i + 3],
      level: flat[i + 4],
      dead: false,
      sleeping: false,
      vx: 0,
      vy: 0
    }, flat[i + 5]);
    map.set(nid, body);
  }
  return map;
}

/** 打包投射口列表（next 是「下一个」预览等级，只有本人那条会用到） */
export function encodeLaunchers(list) {
  const out = [];
  for (const L of list) {
    out.push(L.seat | 0, Math.round(L.x), L.level | 0, L.ready ? 1 : 0, L.next | 0);
  }
  return out;
}

/** 解包投射口列表 → Map(seat → {seat, x, level, ready, next}) */
export function decodeLaunchers(flat) {
  const map = new Map();
  if (!flat) return map;
  for (let i = 0; i + LAUNCH_STRIDE <= flat.length; i += LAUNCH_STRIDE) {
    map.set(flat[i], {
      seat: flat[i],
      x: flat[i + 1],
      level: flat[i + 2],
      ready: !!flat[i + 3],
      next: flat[i + 4]
    });
  }
  return map;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 快照缓冲：收包 → 按本地时间轴插值取样。
 *
 * 用法：
 *   buf.push(snapMsg);                     // 收到 host 快照
 *   const view = buf.sample(Date.now());   // 每帧取一次
 *   view.bodies   → 插值后的刚体数组（可直接喂给渲染）
 *   view.launchers→ 插值后的投射口 Map
 *   view.data     → 最新一帧的非位置字段（分数 / 血量 / 墙血 …）
 */
export class SnapshotBuffer {
  constructor() {
    this.frames = [];
    this.lastSeq = -1;
    this.lastRecvAt = 0;
  }

  clear() {
    this.frames.length = 0;
    this.lastSeq = -1;
    this.lastRecvAt = 0;
  }

  get empty() {
    return this.frames.length === 0;
  }

  /** 最新一帧的原始报文（非位置字段直接读它，无需插值） */
  get latest() {
    return this.frames.length ? this.frames[this.frames.length - 1].msg : null;
  }

  /**
   * 收下一帧快照。乱序到达（seq 比已有的旧）直接丢弃 —— 转发服务不保证顺序，
   * 而插值只需要单调递增的时间轴。
   */
  push(msg, nowMs = Date.now()) {
    const seq = msg.q | 0;
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    this.lastRecvAt = nowMs;
    this.frames.push({
      seq,
      recvAt: nowMs,
      msg,
      bodies: decodeBodies(msg.b),
      launchers: decodeLaunchers(msg.L)
    });
    while (this.frames.length > SNAPSHOT_BUFFER) this.frames.shift();
    return true;
  }

  /**
   * 取「现在 - delay」时刻的世界。
   * @param {number} nowMs 本地当前时间
   * @param {number} [delay] 插值延迟，缺省用配置值
   */
  sample(nowMs = Date.now(), delay = INTERP_DELAY_MS) {
    if (!this.frames.length) return null;
    const target = nowMs - delay;
    const last = this.frames[this.frames.length - 1];

    // 目标时刻已经超过最新帧（网络卡顿）：直接用最新帧，不外推。
    // 外推在密堆场景会把水果推进墙里，视觉上比「短暂定格」更糟。
    if (this.frames.length === 1 || target >= last.recvAt) {
      return this._view(last, last, 1);
    }

    let older = this.frames[0];
    let newer = this.frames[0];
    for (let i = 1; i < this.frames.length; i++) {
      if (this.frames[i].recvAt >= target) {
        older = this.frames[i - 1];
        newer = this.frames[i];
        break;
      }
    }
    const span = newer.recvAt - older.recvAt;
    const t = span > 0 ? Math.max(0, Math.min(1, (target - older.recvAt) / span)) : 1;
    return this._view(older, newer, t);
  }

  _view(older, newer, t) {
    const bodies = [];
    for (const [nid, nb] of newer.bodies) {
      const ob = older.bodies.get(nid);
      if (ob && t < 1) {
        bodies.push({
          nid,
          x: lerp(ob.x, nb.x, t),
          y: lerp(ob.y, nb.y, t),
          r: lerp(ob.r, nb.r, t),
          level: nb.level,
          isZombie: nb.isZombie,
          isStatic: nb.isStatic,
          isCore: nb.isCore,
          isArtifact: nb.isArtifact,
          noMerge: nb.noMerge,
          dead: false,
          sleeping: false,
          vx: 0,
          vy: 0
        });
      } else {
        // 新出现的刚体没有上一帧可插，直接用当前位置（表现为「出现」而不是从别处飞来）
        bodies.push(Object.assign({}, nb));
      }
    }

    const launchers = new Map();
    for (const [seat, nl] of newer.launchers) {
      const ol = older.launchers.get(seat);
      launchers.set(seat, {
        seat,
        x: ol && t < 1 ? lerp(ol.x, nl.x, t) : nl.x,
        level: nl.level,
        ready: nl.ready,
        next: nl.next
      });
    }

    return { bodies, launchers, data: newer.msg, t };
  }
}
