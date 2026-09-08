/**
 * 场景背景：预生成像素风插画 + 廉价粒子/雾气动效。
 * kind: lobby | merge | zombie | resultFail | resultWin
 */
import { applyPixelCtx, fillDitherBg, PIXEL, snap } from './pixel.js';
import { bgSprite } from './assets.js';

const FALLBACK = {
  lobby: ['#140c22', '#24143c'],
  merge: ['#7ec8e8', '#f7d7a8'],
  zombie: ['#0c140e', '#1a2a18'],
  resultFail: ['#0a1018', '#182028'],
  resultWin: ['#1a1028', '#2a1840']
};

const FLOOR = {
  lobby: { fill: '#1a1024', hi: '#4a2870' },
  merge: { fill: '#c4785a', hi: '#f0c8a0' },
  zombie: { fill: '#14140c', hi: '#3a4a22' },
  resultFail: { fill: '#12141a', hi: '#2a3040' },
  resultWin: { fill: '#1a1428', hi: '#4a3060' }
};

function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function drawCover(ctx, img, W, H) {
  const ir = img.width / img.height;
  const br = W / H;
  let dw, dh, dx, dy;
  if (ir > br) {
    dh = H;
    dw = H * ir;
    dx = (W - dw) / 2;
    dy = 0;
  } else {
    dw = W;
    dh = W / ir;
    dx = 0;
    dy = (H - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}

function drawFloor(ctx, W, H, floorY, kind) {
  if (floorY == null || floorY >= H) return;
  const f = FLOOR[kind] || FLOOR.lobby;
  ctx.fillStyle = f.fill;
  ctx.fillRect(0, snap(floorY), W, H - floorY);
  ctx.fillStyle = f.hi;
  ctx.fillRect(0, snap(floorY), W, PIXEL);
}

function fxLobby(ctx, W, H, t) {
  ctx.fillStyle = `rgba(40,16,80,${0.08 + 0.04 * Math.sin(t * 0.6)})`;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 3; i++) {
    const y = ((t * (12 + i * 7) + i * 220) % (H + 160)) - 80;
    ctx.fillStyle = `rgba(90,50,140,${0.07 + i * 0.02})`;
    ctx.fillRect(0, snap(y), W, 70 + i * 16);
  }
  for (let i = 0; i < 22; i++) {
    const hx = hash(i);
    const hy = hash(i + 40);
    const x = snap(hx * W);
    const y = snap((hy * 0.7 + 0.08) * H + Math.sin(t * (0.8 + hx) + i) * 18);
    const a = 0.25 + 0.75 * Math.abs(Math.sin(t * 2.4 + i * 1.7));
    ctx.globalAlpha = a;
    ctx.fillStyle = i % 3 === 0 ? '#9cff6a' : '#ffe08a';
    const s = i % 5 === 0 ? 6 : 4;
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
}

function fxMerge(ctx, W, H, t) {
  ctx.fillStyle = `rgba(255,230,170,${0.05 + 0.03 * Math.sin(t * 0.9)})`;
  ctx.fillRect(0, 0, W, H);
  const colors = ['#ff8fb8', '#ffd36a', '#fff1c8', '#ff9a6a'];
  for (let i = 0; i < 16; i++) {
    const hx = hash(i + 2);
    const speed = 28 + hx * 36;
    const x = snap(((hx * W) + Math.sin(t * 0.7 + i) * 40 + W) % W);
    const y = snap(((t * speed + hyOff(i) * H) % (H + 40)) - 20);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(x, y, 8, 5);
    ctx.fillRect(x + 2, y + 5, 5, 4);
  }
  for (let i = 0; i < 12; i++) {
    const hx = hash(i + 90);
    const hy = hash(i + 110);
    const blink = Math.sin(t * 5 + i * 2);
    if (blink < 0.15) continue;
    ctx.globalAlpha = 0.35 + 0.45 * blink;
    ctx.fillStyle = '#fff7d6';
    ctx.fillRect(snap(hx * W), snap(hy * H * 0.72), 4, 4);
  }
  ctx.globalAlpha = 1;
}

function hyOff(i) {
  return hash(i + 70);
}

function fxZombie(ctx, W, H, t) {
  ctx.fillStyle = 'rgba(4,10,6,0.22)';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 4; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const y = snap(80 + i * (H / 5) + Math.sin(t * 0.4 + i) * 18);
    const x = snap(((t * dir * (18 + i * 6)) % (W + 200)) - 100);
    ctx.fillStyle = `rgba(50,90,40,${0.08 + i * 0.02})`;
    ctx.fillRect(x, y, W * 0.7, 90);
  }
  for (let i = 0; i < 20; i++) {
    const hx = hash(i + 3);
    const speed = 16 + hx * 22;
    const x = snap(hx * W + Math.sin(t * 0.6 + i) * 10);
    const y = snap(H - ((t * speed + hash(i + 9) * H) % H));
    ctx.globalAlpha = 0.25 + 0.35 * hash(i + 12);
    ctx.fillStyle = '#7dff6a';
    ctx.fillRect(x, y, 3, 6);
  }
  ctx.globalAlpha = 1;
  const flash = (t % 7.4);
  if (flash < 0.07) {
    ctx.fillStyle = `rgba(200,255,180,${0.16 * (1 - flash / 0.07)})`;
    ctx.fillRect(0, 0, W, H);
  } else if (flash > 0.18 && flash < 0.24) {
    ctx.fillStyle = 'rgba(180,255,160,0.07)';
    ctx.fillRect(0, 0, W, H);
  }
}

function fxResultFail(ctx, W, H, t) {
  ctx.fillStyle = 'rgba(6,10,18,0.18)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(160,190,220,0.35)';
  for (let i = 0; i < 42; i++) {
    const hx = hash(i + 5);
    const x = snap(((hx * W) + t * 30) % W);
    const y = snap(((t * (220 + hx * 160) + hash(i + 8) * H) % (H + 30)) - 15);
    ctx.fillRect(x, y, 2, 12);
  }
}

function fxResultWin(ctx, W, H, t) {
  ctx.fillStyle = `rgba(255,210,90,${0.04 + 0.03 * Math.sin(t * 1.2)})`;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 18; i++) {
    const hx = hash(i + 21);
    const x = snap(hx * W + Math.sin(t * 0.8 + i) * 12);
    const y = snap(H - ((t * (22 + hx * 28) + hash(i + 4) * H) % H));
    ctx.globalAlpha = 0.35 + 0.5 * Math.abs(Math.sin(t * 2 + i));
    ctx.fillStyle = i % 2 ? '#ffe08a' : '#b6ff7a';
    ctx.fillRect(x, y, 5, 5);
  }
  ctx.globalAlpha = 1;
}

const FX = {
  lobby: fxLobby,
  merge: fxMerge,
  zombie: fxZombie,
  resultFail: fxResultFail,
  resultWin: fxResultWin
};

/**
 * @param {string} kind
 * @param {number} [floorY] 有值时在底部画一条场地线
 */
export function drawSceneBg(ctx, W, H, kind, floorY) {
  const t = Date.now() / 1000;
  const fb = FALLBACK[kind] || FALLBACK.lobby;
  applyPixelCtx(ctx);
  const img = bgSprite(kind);
  if (img && img.width) {
    ctx.imageSmoothingEnabled = true;
    drawCover(ctx, img, W, H);
  } else {
    fillDitherBg(ctx, W, H, fb[0], fb[1], 8);
  }
  applyPixelCtx(ctx);
  const fx = FX[kind];
  if (fx) fx(ctx, W, H, t);
  drawFloor(ctx, W, H, floorY, kind);
}

export function drawStageBg(ctx, W, H, floorY, kind) {
  drawSceneBg(ctx, W, H, kind, floorY);
}
