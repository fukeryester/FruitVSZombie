/**
 * 球体 / 僵尸 / 蛇节渲染 —— 像素贴图 + 扁平色块回退
 */
import { levels } from '../config/balls.js';
import { applyPixelCtx, palette, snap, fillPixelText } from './pixel.js';
import { drawSprite, fruitSprite, zombieSprite, coreSprite } from './assets.js';

function drawPixelOrb(ctx, x, y, r, color, edge) {
  x = snap(x); y = snap(y); r = Math.max(2, snap(r));
  ctx.save();
  applyPixelCtx(ctx);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = edge || palette.ink;
  ctx.lineWidth = Math.max(2, snap(r * 0.08));
  ctx.stroke();
  const hs = Math.max(2, snap(r * 0.22));
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(x - snap(r * 0.38), y - snap(r * 0.42), hs, Math.max(2, snap(hs * 0.55)));
  ctx.restore();
}

export function drawBall(ctx, x, y, r, level) {
  if (drawSprite(ctx, fruitSprite(level), x, y, r)) return;
  const cfg = levels[level] || levels[0];
  drawPixelOrb(ctx, x, y, r, cfg.color, palette.ink);
}

export function drawZombie(ctx, x, y, r, level) {
  if (drawSprite(ctx, zombieSprite(level), x, y, r)) return;
  drawPixelOrb(ctx, x, y, r, '#5d8a35', '#1e3210');
  if (r < 26) return;
  const eye = Math.max(4, snap(r * 0.22));
  ctx.save();
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = Math.max(2, snap(r * 0.07));
  for (const sx of [-1, 1]) {
    const cx = snap(x + sx * r * 0.32);
    const cy = snap(y - r * 0.12);
    ctx.beginPath();
    ctx.moveTo(cx - eye / 2, cy - eye / 2);
    ctx.lineTo(cx + eye / 2, cy + eye / 2);
    ctx.moveTo(cx + eye / 2, cy - eye / 2);
    ctx.lineTo(cx - eye / 2, cy + eye / 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawZombieCore(ctx, x, y, r) {
  if (drawSprite(ctx, coreSprite(), x, y, r)) return;
  drawPixelOrb(ctx, x, y, r, '#d92534', '#4a0810');
}

export function drawArtifact(ctx, x, y, r, icon) {
  x = snap(x); y = snap(y); r = Math.max(4, snap(r));
  ctx.save();
  applyPixelCtx(ctx);
  ctx.fillStyle = palette.ink;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.fillStyle = '#f5c542';
  ctx.fillRect(x - r + 3, y - r + 3, r * 2 - 6, r * 2 - 6);
  ctx.fillStyle = '#fff3c2';
  ctx.fillRect(x - r + 3, y - r + 3, r * 2 - 6, 4);
  ctx.fillStyle = '#b8860b';
  ctx.fillRect(x - r + 3, y + r - 7, r * 2 - 6, 4);
  ctx.fillStyle = palette.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fillPixelText(ctx, icon || '★', x, y, Math.round(r * 1.05));
  ctx.restore();
}

export function lighten(hex) {
  try {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.min(255, Math.floor(v * 0.55 + 255 * 0.45));
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  } catch (e) {
    return hex;
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawSnakeConnection(ctx, x1, y1, x2, y2, r, color) {
  ctx.save();
  applyPixelCtx(ctx);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(4, snap(r * 2));
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(snap(x1), snap(y1));
  ctx.lineTo(snap(x2), snap(y2));
  ctx.stroke();
  ctx.restore();
}

export function drawSnakeNode(ctx, node) {
  const { x, y, r, isHead, isCard, pulseT = 0, hp, maxHp } = node;
  let bodyColor, edgeColor;
  if (isCard) {
    const hue = (pulseT * 18) % 360;
    const light = 55 + Math.sin(pulseT * Math.PI * 2 * 0.8) * 12;
    bodyColor = `hsl(${hue}, 85%, ${light}%)`;
    edgeColor = `hsl(${(hue + 30) % 360}, 90%, 70%)`;
  } else if (isHead) {
    bodyColor = '#ff7a4a';
    edgeColor = '#6b1d0a';
  } else {
    bodyColor = '#a23455';
    edgeColor = '#28000c';
  }
  drawPixelOrb(ctx, x, y, r, bodyColor, edgeColor);

  if (isCard && node.cardIcon) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fillPixelText(ctx, node.cardIcon, x, y + 1, Math.round(r * 2.0));
    ctx.restore();
  } else if (r >= 16) {
    const eye = Math.max(4, snap(r * 0.28));
    ctx.save();
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = Math.max(2, snap(r * 0.12));
    applyPixelCtx(ctx);
    for (const sx of [-1, 1]) {
      const cx = snap(x + sx * r * 0.32);
      const cy = snap(y - r * 0.12);
      ctx.beginPath();
      ctx.moveTo(cx - eye / 2, cy - eye / 2);
      ctx.lineTo(cx + eye / 2, cy + eye / 2);
      ctx.moveTo(cx + eye / 2, cy - eye / 2);
      ctx.lineTo(cx - eye / 2, cy + eye / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  if (maxHp > 0 && r >= 16) {
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    const barW = snap(r * 1.05);
    const barH = Math.max(6, snap(r * 0.12));
    const barX = snap(x - barW / 2);
    const barY = snap(y + r + 6);

    if (hp < maxHp) {
      const fontSize = Math.max(14, Math.round(r * 0.22));
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff5f5';
      fillPixelText(ctx, `${Math.ceil(hp)}/${maxHp}`, x, barY - fontSize * 0.65, fontSize);
      ctx.restore();
    }

    ctx.fillStyle = palette.ink;
    ctx.fillRect(barX, barY, barW, barH);
    const hpColor = ratio > 0.5 ? '#7be07b' : (ratio > 0.25 ? '#ffb84a' : '#ff3b30');
    const fillW = Math.max(2, snap(barW * ratio));
    ctx.fillStyle = hpColor;
    ctx.fillRect(barX + 1, barY + 1, Math.max(0, fillW - 2), Math.max(1, barH - 2));
  }
}
