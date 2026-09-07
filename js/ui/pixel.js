/**
 * 像素风绘制原语
 * ------------------------------------------------------------------
 * 关闭插值、坐标取整、切角面板、抖动背景、描边字。
 */

export const PIXEL = 4;

export const palette = {
  ink: '#1a1020',
  gold: '#ffd24a',
  cream: '#f4ead2',
  panel: '#2a2038',
  panelInner: '#3a2c4e',
  white: '#fff7e8',
  danger: '#ff3b4a',
  hp: '#e84a4a',
  ok: '#4caf50'
};

export function applyPixelCtx(ctx) {
  ctx.imageSmoothingEnabled = false;
  if ('webkitImageSmoothingEnabled' in ctx) ctx.webkitImageSmoothingEnabled = false;
  if ('mozImageSmoothingEnabled' in ctx) ctx.mozImageSmoothingEnabled = false;
}

export function snap(v) {
  return Math.round(v);
}

export function pxFont(ctx, size, bold = true) {
  ctx.font = `${bold ? 'bold ' : ''}${Math.max(12, snap(size))}px sans-serif`;
}

/**
 * 像素字：坐标取整 + 暗色 1px 十字描边，关闭插值。
 * 不用离屏放大，避免蛇身等大量数字把帧成本打爆。
 */
export function fillPixelText(ctx, text, x, y, size) {
  if (text == null || text === '') return;
  const str = String(text);
  if (size) pxFont(ctx, size);
  const color = typeof ctx.fillStyle === 'string' ? ctx.fillStyle : '#ffffff';
  const outline = luminance(color) > 140 ? palette.ink : '#fff6de';
  const sx = snap(x);
  const sy = snap(y);
  ctx.save();
  applyPixelCtx(ctx);
  ctx.fillStyle = outline;
  ctx.fillText(str, sx - 2, sy);
  ctx.fillText(str, sx + 2, sy);
  ctx.fillText(str, sx, sy - 2);
  ctx.fillText(str, sx, sy + 2);
  ctx.fillStyle = color;
  ctx.fillText(str, sx, sy);
  ctx.restore();
}

export function measurePixelText(ctx, text, size) {
  if (size) pxFont(ctx, size);
  return ctx.measureText(String(text)).width;
}

function luminance(hex) {
  if (typeof hex !== 'string') return 200;
  if (hex.startsWith('#') && hex.length >= 7) {
    const n = parseInt(hex.slice(1, 7), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const m = hex.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
  return 200;
}

/** 抖动棋盘背景（复古瓦片感） */
export function fillDitherBg(ctx, w, h, c1, c2, cell = 8) {
  ctx.fillStyle = c1;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = c2;
  const s = cell;
  const s2 = s * 2;
  for (let y = 0; y < h; y += s2) {
    for (let x = 0; x < w; x += s2) {
      ctx.fillRect(x, y, s, s);
      ctx.fillRect(x + s, y + s, s, s);
    }
  }
}

/** 切角像素面板：外框墨色 + 内填 + 左上高光 */
export function pixelPanel(ctx, x, y, w, h, opts = {}) {
  x = snap(x); y = snap(y); w = snap(w); h = snap(h);
  const border = opts.border || PIXEL;
  const fill = opts.fill || palette.panel;
  const stroke = opts.stroke || palette.ink;
  const hi = opts.highlight !== false;
  ctx.fillStyle = stroke;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fillRect(x + border, y + border, Math.max(0, w - border * 2), Math.max(0, h - border * 2));
  if (hi && w > border * 2 && h > border * 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x + border, y + border, Math.max(0, w - border * 2), PIXEL);
    ctx.fillRect(x + border, y + border, PIXEL, Math.max(0, h - border * 2));
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(x + border, y + h - border - PIXEL, Math.max(0, w - border * 2), PIXEL);
    ctx.fillRect(x + w - border - PIXEL, y + border, PIXEL, Math.max(0, h - border * 2));
  }
}

/** 扁平进度条（无圆角、无渐变） */
export function pixelBar(ctx, x, y, w, h, ratio, fill, bg = 'rgba(0,0,0,0.45)') {
  x = snap(x); y = snap(y); w = snap(w); h = snap(h);
  const r = Math.max(0, Math.min(1, ratio));
  ctx.fillStyle = palette.ink;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = bg;
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  const pw = snap((w - 6) * r);
  if (pw > 0) {
    ctx.fillStyle = fill;
    ctx.fillRect(x + 3, y + 3, pw, h - 6);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x + 3, y + 3, pw, 3);
  }
}

export function pixelRect(ctx, x, y, w, h, fill) {
  ctx.fillStyle = fill;
  ctx.fillRect(snap(x), snap(y), snap(w), snap(h));
}

/** 像素虚线（横向或纵向） */
export function pixelDashLine(ctx, x1, y1, x2, y2, color, thick = 4, on = 10, off = 8) {
  ctx.fillStyle = color;
  const t = Math.max(2, snap(thick));
  if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
    const y = snap(Math.min(y1, y2));
    const x0 = snap(Math.min(x1, x2));
    const x1s = snap(Math.max(x1, x2));
    for (let x = x0; x < x1s; x += on + off) {
      ctx.fillRect(x, y, Math.min(on, x1s - x), t);
    }
  } else {
    const x = snap(Math.min(x1, x2));
    const y0 = snap(Math.min(y1, y2));
    const y1s = snap(Math.max(y1, y2));
    for (let y = y0; y < y1s; y += on + off) {
      ctx.fillRect(x, y, t, Math.min(on, y1s - y));
    }
  }
}

/** 像素砖墙（可破坏墙体） */
export function fillBrick(ctx, x, y, w, h, c1, c2) {
  x = snap(x); y = snap(y); w = snap(w); h = snap(h);
  if (w <= 18 || h <= 18) {
    ctx.fillStyle = c2;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    if (w <= h) ctx.fillRect(x, y, Math.min(3, w), h);
    else ctx.fillRect(x, y, w, Math.min(3, h));
    return;
  }
  ctx.fillStyle = c1;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = c2;
  const bs = 10;
  const mortar = 2;
  const rowH = bs + mortar;
  for (let row = 0, yy = y; yy < y + h; row++, yy += rowH) {
    const offset = (row % 2) * Math.floor(bs / 2);
    for (let xx = x - offset; xx < x + w; xx += bs + mortar) {
      const rx = Math.max(x, xx);
      const rw = Math.min(x + w, xx + bs) - rx;
      const rh = Math.min(y + h, yy + bs) - yy;
      if (rw > 0 && rh > 0) ctx.fillRect(rx, yy, rw, rh);
    }
  }
}

/** 合成/击杀掉落的方框扩散特效 */
export function drawPixelBurst(ctx, e) {
  const p = e.t / e.dur;
  const rr = snap(e.r + p * 36);
  ctx.save();
  ctx.globalAlpha = 1 - p;
  ctx.strokeStyle = e.color;
  ctx.lineWidth = Math.max(2, snap(6 * (1 - p) + 1));
  applyPixelCtx(ctx);
  ctx.strokeRect(snap(e.x - rr), snap(e.y - rr), rr * 2, rr * 2);
  ctx.restore();
}
