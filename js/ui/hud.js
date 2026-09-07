/**
 * 局内 / 大厅共用的像素 HUD 件
 */
import { levels } from '../config/balls.js';
import { drawBall } from './ballRenderer.js';
import {
  applyPixelCtx, fillPixelText, pxFont, pixelPanel, pixelBar,
  fillDitherBg, pixelDashLine, PIXEL, palette, snap
} from './pixel.js';

export const THEME = {
  lobby: {
    bg1: '#1a1030', dither: '#2a1848', floor: '#24143c', floorHi: '#3d2466',
    text: '#fff7e8', muted: 'rgba(255,247,232,0.75)'
  },
  merge: {
    bg1: '#e8b4c4', dither: '#f4d0dc', floor: '#7a5344', floorHi: '#a07460',
    text: '#2a1810', muted: 'rgba(42,24,16,0.7)'
  },
  zombie: {
    bg1: '#9cc46c', dither: '#b8d888', floor: '#5c4a34', floorHi: '#7a6448',
    text: '#1a2410', muted: 'rgba(26,36,16,0.7)'
  },
  snake: {
    bg1: '#160c20', dither: '#281438', floor: '#100818', floorHi: '#3a1850',
    text: '#f3e7ff', muted: 'rgba(243,231,255,0.75)'
  }
};

export function drawStageBg(ctx, W, H, floorY, theme) {
  applyPixelCtx(ctx);
  fillDitherBg(ctx, W, H, theme.bg1, theme.dither, 8);
  ctx.fillStyle = theme.floor;
  ctx.fillRect(0, snap(floorY), W, H - floorY);
  ctx.fillStyle = theme.floorHi;
  ctx.fillRect(0, snap(floorY), W, PIXEL);
}

export function drawWarnLine(ctx, W, y, flash) {
  pixelDashLine(ctx, 0, y, W, y, flash ? palette.danger : '#c43c28', 4, 12, 8);
}

export function drawDropGuide(ctx, x, y, r, floorY, color) {
  pixelDashLine(ctx, x, y + r, x, floorY, color, 3, 8, 8);
}

export function drawScoreChip(ctx, score) {
  pixelPanel(ctx, 16, 66, 144, 144, { fill: '#241830', border: 4 });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.gold;
  fillPixelText(ctx, String(score), 88, 138, 52);
}

export function drawNextChip(ctx, W, nextLevel) {
  const cx = W - 134;
  pixelPanel(ctx, W - 206, 66, 144, 144, { fill: '#241830', border: 4 });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.white;
  fillPixelText(ctx, '下一个', cx, 98, 26);
  const nr = Math.max(16, levels[nextLevel].radius * 0.32);
  drawBall(ctx, cx, 172, nr, nextLevel);
}

export function drawLevelBadge(ctx, game, flash) {
  const lv = game.playerLevel;
  const topPad = (game.safeTop || 20) + 4;
  const w = 132, h = 44;
  const x = 22, y = topPad;
  const scale = 1 + Math.max(0, flash || 0) * 0.18;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(scale, scale);
  ctx.translate(-(x + w / 2), -(y + h / 2));
  pixelPanel(ctx, x, y, w, h, { fill: flash > 0 ? '#5a3a18' : '#241830', border: 3 });
  // 像素方块宝石代替平滑五角星
  ctx.fillStyle = flash > 0 ? '#ff9a3d' : palette.gold;
  const sx = x + 22, sy = y + h / 2;
  ctx.fillRect(sx - 8, sy - 4, 16, 8);
  ctx.fillRect(sx - 4, sy - 8, 8, 16);
  ctx.fillStyle = flash > 0 ? '#fff7e0' : palette.white;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  fillPixelText(ctx, `Lv.${lv}`, x + h - 4, y + h / 2, 26);
  if (flash > 0) {
    ctx.globalAlpha = flash;
    ctx.strokeStyle = palette.gold;
    ctx.lineWidth = 3;
    ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
  }
  ctx.restore();
}

export function drawCardProgress(ctx, W, label, cur, total, darkText) {
  pxFont(ctx, 28);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  const tx = Math.max(88, Math.min(W / 2, tw / 2 + 19));
  const ty = 239;
  pixelPanel(ctx, tx - tw / 2 - 17, ty - 29, tw + 34, 58, {
    fill: darkText ? '#f4ead2' : '#241830',
    border: 3
  });
  ctx.fillStyle = cur >= total ? palette.danger : (darkText ? '#2a1810' : palette.white);
  fillPixelText(ctx, label, tx, ty, 28);
}

export function drawTopBar(ctx, game, W, ratio, fill, label, fillStyle) {
  const topPad = (game.safeTop || 20) + 23;
  const bh = 48;
  const bx = 183;
  const bw = Math.max(308, W - 412);
  const by = topPad;
  pixelBar(ctx, bx, by, bw, bh, ratio, fill, 'rgba(20,16,28,0.55)');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fillStyle || palette.ink;
  fillPixelText(ctx, label, bx + bw / 2, by + bh / 2, 26);
  return { bx, by, bw, bh };
}

export function drawBanner(ctx, W, H, title, subtitle, titleColor) {
  pixelPanel(ctx, W / 2 - 330, H * 0.34, 660, 190, { fill: '#1a1028', border: 6 });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = titleColor || palette.gold;
  fillPixelText(ctx, title, W / 2, H * 0.34 + 60, 44);
  ctx.fillStyle = palette.white;
  fillPixelText(ctx, subtitle, W / 2, H * 0.34 + 130, 28);
}
