/**
 * 联机专属 HUD
 * ------------------------------------------------------------------
 * · 其他玩家的投射口（按座位色描边 + 名牌 + 落点虚线）
 * · 右侧队伍计分板（房间号表头 + 每人实时得分，高亮自己）
 *
 * 单机时这些全都不会被调用，HUD 与改造前完全一致。
 *
 * 布局约束（很容易踩）
 * ------------------------------------------------------------------
 * 四个人共用同一条投放线 dropY=212，所以 **y 在 175~250、x 横跨全屏** 这一条
 * 带子属于玩法区，联机 HUD 一律不能占：
 *   · 计分板整体下移到 y=PANEL_Y（270），让开投射口；
 *   · 名牌不能画在投射口上方（那里是分数圈 / 下一个 / 抽卡进度三块 HUD 的
 *     地盘，而且它们后画，会直接把名牌盖掉），改为画在方框侧边；
 *   · 房间号 / 断线告警并进计分板表头，不再单独占屏幕中央一条。
 */
import { drawBall } from './ballRenderer.js';
import {
  applyPixelCtx, fillPixelText, pixelPanel, pixelDashLine, palette, pxFont, snap
} from './pixel.js';
import { seatColor } from '../config/net.js';

/** 计分板顶边：必须低于投射口方框的下沿（212+30+4） */
const PANEL_Y = 270;
const PANEL_W = 200;

function shortName(name, max = 6) {
  const s = String(name || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 画一个远端玩家的投射口。
 * @param {object} L { seat, x, level, ready }
 * @param {number} W 屏幕宽（名牌贴边时要翻到方框另一侧）
 */
export function drawRemoteLauncher(ctx, L, dropY, floorY, name, W) {
  const color = seatColor(L.seat);
  const x = snap(L.x);
  const half = 30;
  ctx.save();
  applyPixelCtx(ctx);

  // 落点提示线（比自己的淡一些，避免抢视线）
  pixelDashLine(ctx, x, dropY + 26, x, floorY, color, 3, 6, 14);

  if (L.ready) {
    ctx.globalAlpha = 0.9;
    drawBall(ctx, x, dropY, half, L.level | 0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x - half - 4, dropY - half - 4, (half + 4) * 2, (half + 4) * 2);
  } else {
    // 冷却中：只留一个空框，让队友知道他马上还会再来一发
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x - 26, dropY - 26, 52, 52);
    ctx.globalAlpha = 1;
  }

  // 名牌贴在方框侧边，自带底板保证压在背景上也看得清
  const label = shortName(name, 5);
  pxFont(ctx, 20);
  const tw = ctx.measureText(label).width;
  const plateW = tw + 14;
  const gap = half + 10;
  const toLeft = W && x + gap + plateW > W - 8;
  const px = toLeft ? x - gap - plateW : x + gap;
  pixelPanel(ctx, px, dropY - 15, plateW, 30, { fill: 'rgba(20,14,32,0.82)', border: 2 });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  fillPixelText(ctx, label, px + plateW / 2, dropY, 20);
  ctx.restore();
}

/** 自己的投射口加一圈座位色描边，方便在四个球里认出自己 */
export function drawSelfLauncherRing(ctx, x, y, r, seat) {
  ctx.save();
  applyPixelCtx(ctx);
  ctx.strokeStyle = seatColor(seat);
  ctx.lineWidth = 4;
  ctx.strokeRect(snap(x - r - 6), snap(y - r - 6), snap((r + 6) * 2), snap((r + 6) * 2));
  ctx.restore();
}

/**
 * 右侧队伍计分板（表头兼作房间号 / 断线告警条）。
 * @param {Array} rows StageSync.scoreRows() 的输出 [{ seat, name, score, you, host }]
 * @param {string} title 表头文字，通常是「房间 XXXXXX · 主机」
 * @param {boolean} warn 表头转为告警配色（与房主失联时）
 */
export function drawTeamPanel(ctx, W, rows, title, warn) {
  if (!rows || !rows.length) return;
  const w = PANEL_W;
  const rowH = 46;
  const headH = title ? 34 : 0;
  const x = W - w - 16;
  const y = PANEL_Y;
  const h = headH + rowH * rows.length + 12;
  ctx.save();
  applyPixelCtx(ctx);
  pixelPanel(ctx, x, y, w, h, { fill: 'rgba(20,14,32,0.86)', border: 3 });
  ctx.textBaseline = 'middle';

  if (title) {
    ctx.fillStyle = warn ? '#5a1220' : 'rgba(58,42,86,0.9)';
    ctx.fillRect(x + 3, y + 3, w - 6, headH - 3);
    ctx.textAlign = 'center';
    ctx.fillStyle = warn ? palette.danger : 'rgba(255,247,232,0.85)';
    fillPixelText(ctx, title, x + w / 2, y + headH / 2 + 2, 20);
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ry = y + headH + 6 + i * rowH;
    ctx.save();
    if (r.offline) ctx.globalAlpha = 0.4;
    ctx.fillStyle = seatColor(r.seat);
    ctx.fillRect(x + 8, ry + 8, 8, rowH - 16);
    ctx.textAlign = 'left';
    ctx.fillStyle = r.you ? palette.gold : palette.white;
    fillPixelText(ctx, shortName(r.name) + (r.host ? ' ♦' : ''), x + 24, ry + 15, 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = palette.white;
    fillPixelText(ctx, String(r.score | 0), x + w - 14, ry + 34, 24);
    ctx.restore();
  }
  ctx.restore();
}
