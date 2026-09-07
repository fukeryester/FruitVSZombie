/**
 * 二维圆形刚体物理引擎（轻量自研）
 * ------------------------------------------------------------------
 * - 重力 / 弹性 / 摩擦，位置修正 + 法向冲量解算
 * - 同级碰撞 → onMerge 回调（由上层决定合成逻辑与得分）
 * - O(n²) 碰撞检测，水果量级（<100）完全够用
 * - 固定步长子步进，保证堆叠稳定
 */
import { clamp } from './utils.js';

// 所有带长度/速度量纲的常量均基于 750 设计宽（半径等比放大 750/390 ≈ 1.92 后同步升档，
// 屏幕上的动态表现与 390 时代完全一致）。
export const GRAVITY = 5000; // 重力加速度 px/s²（设计单位）

/**
 * 静止判定阈值（手感与判负的生命线）
 * ------------------------------------------------------------------
 * 问题：逐帧「重力加速 + 弹性反弹」会让接触中的球永远微幅弹跳，堆叠越多
 *       抖得越厉害（390 时代实测 30 球静置 12 秒后平均 |vy| 仍有 ~78），导致上层
 *       「越线且接近静止才算」的判负条件永远不成立 → 永远判不出输。
 * 方案：
 *   REST_SPEED  低速接触取消弹性（只做支撑、不反弹），消除微弹跳的能量注入
 *   SLEEP_*     休眠机制：静止够久的球进入休眠（不受重力、视为静态支撑），
 *               从根本上消除深堆残留速度——没有休眠时，上层球会一直保留
 *               每子步的重力增量（390 时代实测 2 层残留 21.6、4 层 58.7、5 层 67.5，
 *               超过上层判负阈值就永远判不出输）
 */
export const REST_SPEED = 154;       // px/s：低于此速度的接触视为支撑而非碰撞
export const SOLVER_ITERATIONS = 4;  // 每子步的碰撞求解迭代次数（深堆收敛）
export const CORRECT_SLOP = 1;       // 位置修正允许的穿透量（px）
export const CORRECT_RATE = 0.8;     // 位置修正比例（<1 抑制能量注入）
export const STILL_SPEED = 115;      // px/s：低于此速度开始累计静止时间
export const STILL_TIME = 0.35;      // s：持续静止多久进入休眠
export const WAKE_SPEED = 173;       // px/s：接触方速度超过此值唤醒休眠球
export const SLEEP_MASS = 1e9;       // 休眠球视为静态支撑（近似无限质量）

export class Body {
  constructor(x, y, r, level, opts = {}) {
    this.x = x;
    this.y = y;
    this.r = r;
    this.level = level; // 球体等级下标（对应 balls.js levels）
    this.vx = 0;
    this.vy = 0;
    this.restitution = opts.restitution ?? 0.25;
    this.friction = opts.friction ?? 0.12;
    this.density = opts.density ?? 0.0012;
    this.dead = false;        // 待移除标记
    this.mergeLock = 0;       // 合成冷却计时（防同帧多次合并）
    this.settledTimer = 0;    // 越线判定只统计"静止"的球
    this.stillTimer = 0;      // 静止累计时长（用于进入休眠）
    this.sleeping = false;    // 休眠中：不受重力，视为静态支撑
    this.isZombie = false;    // 僵尸球（第二阶段）：不参与合成，被水果砸会掉半径
    this.climbAccel = 0;      // 向上的恒定加速度（僵尸爬升用），抵消部分重力
    this.isStatic = false;    // 静态刚体（尸核/神器）：无限质量、不积分、不参与合成
    this.isCore = false;      // 尸核（第二阶段核心目标）：带血量，被水果砸掉血
    this.isArtifact = false;  // 神器：被水果碰到后赋予玩家卡牌增益并消失
    this.noMerge = false;     // 禁止参与合成（如大水果撞墙分裂出的小水果）
  }
  get mass() {
    return (this.sleeping || this.isStatic) ? SLEEP_MASS : this.density * Math.PI * this.r * this.r;
  }
}

export class PhysicsWorld {
  /**
   * @param {Object} bounds {left, right, top, bottom}
   * @param {Function} onMerge (a, b, world) => void  同级球接触时回调
   * @param {Function} [onContact] (a, b, world) => void  任意两球接触时回调
   *        （第二阶段用于水果↔僵尸的互扣半径结算；返回后若一方 dead 则跳过后续）
   */
  constructor(bounds, onMerge, onContact = null, onWallContact = null) {
    this.bounds = bounds;
    this.onMerge = onMerge;
    this.onContact = onContact;
    // 任意球与矩形墙接触时回调（第二阶段：水果撞墙掉血/自毁）。
    // 回调内部可能对墙/球打 dead 标记，迭代安全。
    this.onWallContact = onWallContact;
    this.bodies = [];
    // 矩形墙（AABB，静态）：{ x, y, w, h, dead?, destructible?, hp?, maxHp?, ... }
    this.walls = [];
    // true = 关闭球与球之间的碰撞（球会互相穿透坠落到底层），地面与墙壁仍然生效
    this.noBodyCollide = false;
  }

  addWall(wall) {
    this.walls.push(wall);
    this.wakeAll();
    return wall;
  }

  removeWall(wall) {
    wall.dead = true;
    this.wakeAll(); // 支撑结构变化，全场重新结算
  }

  add(body) {
    this.bodies.push(body);
    this.wakeAll(); // 新球入场，全场重新结算
    return body;
  }

  remove(body) {
    body.dead = true;
    this.wakeAll(); // 支撑结构变化，全场重新结算
  }

  clear() {
    this.bodies.length = 0;
  }

  /** 修改球半径后重建（保持圆心不变） */
  resize(body, newR) {
    body.r = Math.max(15, newR); // 下限随游戏尺度升档（原 8，×1.92）
    this.wakeAll();
  }

  /** 唤醒全部球（投放 / 消除 / 缩放 / 外力等场景调用） */
  wakeAll() {
    for (const b of this.bodies) {
      b.sleeping = false;
      b.stillTimer = 0;
    }
  }

  step(dt) {
    const sub = 2; // 子步进
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      // 自底向上排序：支撑力能从底层逐层传到上层，大幅减少深堆残留速度
      this._sortBottomUp();
      this._integrate(h);
      // 多次迭代求解：球间约束与边界约束（地面/墙）交替求解。
      // 边界必须参与迭代——只在积分阶段解一次的话，整列球的重量没有支撑点，
      // 会持续下沉并保留约 60px/s 的残余速度（正是判负失效的原因）。
      for (let it = 0; it < SOLVER_ITERATIONS; it++) {
        this._collide(h, it === 0, it === 0);
        this._collideWalls(it === 0);
        this._solveBounds(it === 0);
      }
    }
    // 清理死亡球/墙 & 冷却递减 & 休眠判定
    this.bodies = this.bodies.filter(b => !b.dead);
    if (this.walls.length) this.walls = this.walls.filter(w => !w.dead);
    for (const b of this.bodies) {
      if (b.mergeLock > 0) b.mergeLock -= dt;
    }
    this._updateSleep(dt);
  }

  /** 按 y 从大到小（底部优先）排序，供自底向上的求解顺序使用 */
  _sortBottomUp() {
    this.bodies.sort((p, q) => q.y - p.y);
  }

  /** 静止够久的球进入休眠：不受重力、速度归零，成为静态支撑（僵尸/静态刚体永不休眠） */
  _updateSleep(dt) {
    for (const b of this.bodies) {
      if (b.sleeping || b.climbAccel > 0 || b.isStatic) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp < STILL_SPEED) {
        b.stillTimer += dt;
        if (b.stillTimer >= STILL_TIME) {
          b.sleeping = true;
          b.vx = 0;
          b.vy = 0;
        }
      } else {
        b.stillTimer = 0;
      }
    }
  }

  /** 积分：重力 + 位置推进 + 阻尼（边界约束在 _solveBounds 中参与迭代求解） */
  _integrate(h) {
    for (const b of this.bodies) {
      if (b.sleeping || b.isStatic) continue; // 休眠球/静态刚体不受重力，保持静止
      // 僵尸带向上的恒定加速度（climbAccel），抵消部分重力实现"向上爬"
      b.vy += (GRAVITY - (b.climbAccel || 0)) * h;
      b.x += b.vx * h;
      b.y += b.vy * h;
      // 阻尼，防止无限滚动
      b.vx *= 0.999;
      b.vy *= 0.999;
    }
  }

  /**
   * 边界约束（地面 / 左右墙 / 顶部）：作为静态接触参与迭代求解。
   * @param {boolean} applyRestitution 仅首次迭代带弹性，后续纯支撑
   */
  _solveBounds(applyRestitution) {
    const { left, right, top, bottom } = this.bounds;
    for (const b of this.bodies) {
      if (b.sleeping || b.isStatic) continue;
      // 墙壁（低速接触不反弹，避免贴墙抖动）
      if (b.x - b.r < left) {
        b.x = left + b.r;
        b.vx = applyRestitution && b.vx < -REST_SPEED ? -b.vx * b.restitution : 0;
      }
      if (b.x + b.r > right) {
        b.x = right - b.r;
        b.vx = applyRestitution && b.vx > REST_SPEED ? -b.vx * b.restitution : 0;
      }
      // 地面
      if (b.y + b.r > bottom) {
        b.y = bottom - b.r;
        b.vy = applyRestitution && b.vy > REST_SPEED ? -b.vy * b.restitution : 0;
        // 地面摩擦
        b.vx *= 1 - clamp(b.friction * 4, 0, 1);
      }
      // 顶部约束：防止球被挤出屏幕后飞走消失
      if (top !== undefined && b.y - b.r < top) {
        b.y = top + b.r;
        b.vy = applyRestitution && b.vy < -REST_SPEED ? -b.vy * b.restitution : 0;
      }
    }
  }

  /**
   * @param {number} h 子步长
   * @param {boolean} allowMerge 只有每子步的第一次迭代允许触发合成（避免重复回调）
   * @param {boolean} applyRestitution 只有第一次迭代带弹性，后续迭代纯支撑（防能量注入）
   */
  _collide(h, allowMerge, applyRestitution = false) {
    if (this.noBodyCollide) return; // 卡牌效果：球之间互相穿透
    const list = this.bodies;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (a.dead) continue;
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (b.dead || a.dead) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = a.r + b.r;
        if (dist >= minDist || dist === 0) continue;

        // 休眠球被运动中的球碰到 → 唤醒（如新球砸下来、连锁合成）
        if (a.sleeping !== b.sleeping) {
          const awake = a.sleeping ? b : a;
          const asleep = a.sleeping ? a : b;
          if (Math.hypot(awake.vx, awake.vy) > WAKE_SPEED) {
            asleep.sleeping = false;
            asleep.stillTimer = 0;
          }
        }

        // 任意接触回调（第二阶段：水果↔僵尸互扣半径）。
        // 回调内部可能 remove/resize（remove 打 dead 标记、resize 唤醒全场，
        // 都不会动 bodies 数组本身，迭代安全）。
        if (allowMerge && this.onContact) {
          this.onContact(a, b, this);
          if (a.dead || b.dead) continue;
        }

        // 同级 → 合成（交给上层；僵尸与静态刚体永不参与合成，noMerge 碎片被排除）
        if (allowMerge && !a.isZombie && !b.isZombie && !a.isStatic && !b.isStatic &&
            !a.noMerge && !b.noMerge && a.level === b.level) {
          if (a.mergeLock <= 0 && b.mergeLock <= 0) {
            this.onMerge(a, b, this);
            if (a.dead || b.dead) continue;
          }
        }

        // 位置修正（按质量比例分开；留 slop 并按比例修正，抑制能量注入）
        const nx = dx / dist;
        const ny = dy / dist;
        const ma = a.mass;
        const mb = b.mass;
        const total = ma + mb;
        const corr = Math.max(0, minDist - dist - CORRECT_SLOP) * CORRECT_RATE;
        if (corr > 0) {
          a.x -= nx * corr * (mb / total);
          a.y -= ny * corr * (mb / total);
          b.x += nx * corr * (ma / total);
          b.y += ny * corr * (ma / total);
        }

        // 冲量解算
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const velN = rvx * nx + rvy * ny;
        if (velN > 0) continue; // 正在分离
        // 弹性只在首次迭代生效，且低速接触取消弹性（只支撑不反弹）
        let e = 0;
        if (applyRestitution && Math.abs(velN) >= REST_SPEED) {
          e = Math.min(a.restitution, b.restitution);
        }
        const jImp = (-(1 + e) * velN) / (1 / ma + 1 / mb);
        const ix = jImp * nx;
        const iy = jImp * ny;
        a.vx -= ix / ma;
        a.vy -= iy / ma;
        b.vx += ix / mb;
        b.vy += iy / mb;

        // 切向摩擦
        const tx = -ny;
        const ty = nx;
        const velT = rvx * tx + rvy * ty;
        const jt = -velT / (1 / ma + 1 / mb) * Math.min(a.friction, b.friction);
        a.vx -= jt * tx / ma;
        a.vy -= jt * ty / ma;
        b.vx += jt * tx / mb;
        b.vy += jt * ty / mb;
      }
    }
  }

  /**
   * 球 ↔ 矩形墙（AABB，静态无限质量）解算
   * ------------------------------------------------------------------
   * 最近点法：取球心在矩形上的最近点，距离 < r 即接触。
   * 球心陷入矩形内部时（高速穿透），沿最浅穿透轴推出。
   * 接触回调只在每子步首次迭代触发（与 onContact 一致），
   * 回调可能把球/墙打 dead 标记（如水果撞墙自毁），之后跳过解算。
   * @param {boolean} allowContact 是否允许触发 onWallContact（首次迭代）
   */
  _collideWalls(allowContact) {
    const ws = this.walls;
    if (!ws.length) return;
    for (const b of this.bodies) {
      if (b.dead || b.sleeping || b.isStatic) continue;
      for (let k = 0; k < ws.length; k++) {
        const w = ws[k];
        if (w.dead) continue;
        // 快速外框排除
        if (b.x + b.r < w.x || b.x - b.r > w.x + w.w ||
            b.y + b.r < w.y || b.y - b.r > w.y + w.h) continue;
        const cx = clamp(b.x, w.x, w.x + w.w);
        const cy = clamp(b.y, w.y, w.y + w.h);
        let dx = b.x - cx;
        let dy = b.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= b.r * b.r) continue;
        let d = Math.sqrt(d2);
        let nx, ny;
        if (d > 1e-6) {
          nx = dx / d;
          ny = dy / d;
        } else {
          // 球心在矩形内：沿最浅穿透轴推出
          const pl = b.x - w.x, pr = w.x + w.w - b.x;
          const pt = b.y - w.y, pb = w.y + w.h - b.y;
          const m = Math.min(pl, pr, pt, pb);
          if (m === pl) { nx = -1; ny = 0; d = -pl; }
          else if (m === pr) { nx = 1; ny = 0; d = -pr; }
          else if (m === pt) { nx = 0; ny = -1; d = -pt; }
          else { nx = 0; ny = 1; d = -pb; }
        }

        // 接触回调（水果撞墙结算伤害/自毁；僵尸撞墙只物理阻挡）
        if (allowContact && this.onWallContact) {
          this.onWallContact(b, w, this);
          if (b.dead || w.dead) continue;
        }

        // 位置修正（墙无限质量，球承担全部修正）
        const corr = b.r - d;
        b.x += nx * corr;
        b.y += ny * corr;

        // 法向速度：低速接触纯支撑（消抖），高速首次迭代带弹性
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          if (allowContact && -vn >= REST_SPEED) {
            b.vx -= (1 + b.restitution) * vn * nx;
            b.vy -= (1 + b.restitution) * vn * ny;
          } else {
            b.vx -= vn * nx;
            b.vy -= vn * ny;
          }
          // 轻微切向摩擦
          const tx = -ny;
          const ty = nx;
          const vt = b.vx * tx + b.vy * ty;
          const jt = vt * b.friction;
          b.vx -= jt * tx;
          b.vy -= jt * ty;
        }
      }
    }
  }
}
