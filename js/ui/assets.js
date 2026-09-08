/**
 * 贴图加载：水果 / 僵尸 / 尸核
 * ------------------------------------------------------------------
 * 路径相对小游戏包根目录。加载失败时 drawSprite 返回 false，
 * 调用方回退到像素色块，保证首帧也能画。
 */
import { applyPixelCtx, snap } from './pixel.js';

export const FRUIT_SRCS = [
  'Assets/sprites/grape.png',
  'Assets/sprites/cherry.png',
  'Assets/sprites/orange.png',
  'Assets/sprites/lemon.png',
  'Assets/sprites/kiwi.png',
  'Assets/sprites/tomato.png',
  'Assets/sprites/peach.png',
  'Assets/sprites/pineapple.png',
  'Assets/sprites/coconut.png',
  'Assets/sprites/half-watermelon.png',
  'Assets/sprites/watermelon.png'
];

export const ZOMBIE_SRCS = [
  'Assets/sprites/zombie-0.png',
  'Assets/sprites/zombie-1.png',
  'Assets/sprites/zombie-2.png',
  'Assets/sprites/zombie-3.png'
];

export const CORE_SRC = 'Assets/sprites/zombie-core.png';

export const PAY_SRCS = {
  alipay: 'Assets/pay/alipay.jpg',
  wechat: 'Assets/pay/wechat.jpg'
};

export const BG_SRCS = {
  lobby: 'Assets/bg/lobby.jpg',
  merge: 'Assets/bg/merge.jpg',
  zombie: 'Assets/bg/zombie.jpg',
  resultFail: 'Assets/bg/result-fail.jpg',
  resultWin: 'Assets/bg/result-win.jpg'
};

/**
 * 贴图中水果实体相对 64px 画布的轴向半径比（minAxis/32）。
 * 绘制时按 1/fill 放大并裁成正圆，让视觉直径贴合物理半径。
 */
export const FRUIT_BODY_FILL = [
  32 / 32, // grape
  56 / 64, // cherry 左右透明边
  32 / 32, // orange
  58 / 64, // lemon
  32 / 32, // kiwi
  32 / 32, // tomato
  32 / 32, // peach
  54 / 64, // pineapple
  32 / 32, // coconut
  32 / 32, // half-watermelon
  32 / 32  // watermelon
];
export const ZOMBIE_BODY_FILL = [29 / 32, 29 / 32, 26 / 32, 28 / 32];
export const CORE_BODY_FILL = 25 / 32;
/** 再放大并裁成正圆，盖住像素圆外圈暗描边（看起来像间隙） */
const SPRITE_BLEED = 1.14;

export const sprites = {
  fruits: [],
  zombies: [],
  core: null,
  pay: { alipay: null, wechat: null },
  bg: {},
  ready: false
};

function loadOne(src) {
  return new Promise((resolve) => {
    try {
      const img = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage() : null;
      if (!img) { resolve(null); return; }
      img.onload = () => resolve(img);
      img.onerror = () => {
        console.warn('[assets] load fail', src);
        resolve(null);
      };
      img.src = src;
    } catch (e) {
      resolve(null);
    }
  });
}

let preloadPromise = null;

export function preloadSprites() {
  if (preloadPromise) return preloadPromise;
  preloadPromise = Promise.all([
    Promise.all(FRUIT_SRCS.map(loadOne)),
    Promise.all(ZOMBIE_SRCS.map(loadOne)),
    loadOne(CORE_SRC),
    loadOne(PAY_SRCS.alipay),
    loadOne(PAY_SRCS.wechat),
    loadOne(BG_SRCS.lobby),
    loadOne(BG_SRCS.merge),
    loadOne(BG_SRCS.zombie),
    loadOne(BG_SRCS.resultFail),
    loadOne(BG_SRCS.resultWin)
  ]).then(([fruits, zombies, core, alipay, wechat, lobby, merge, zombie, resultFail, resultWin]) => {
    sprites.fruits = fruits;
    sprites.zombies = zombies;
    sprites.core = core;
    sprites.pay.alipay = alipay;
    sprites.pay.wechat = wechat;
    sprites.bg = { lobby, merge, zombie, resultFail, resultWin };
    sprites.ready = true;
    return sprites;
  });
  return preloadPromise;
}

preloadSprites();

export function fruitSprite(level) {
  return sprites.fruits[level] || null;
}

export function zombieSprite(level) {
  const i = Math.max(0, Math.min(ZOMBIE_SRCS.length - 1, level | 0));
  return sprites.zombies[i] || sprites.zombies[0] || null;
}

export function coreSprite() {
  return sprites.core;
}

export function paySprite(kind) {
  return sprites.pay[kind] || null;
}

export function bgSprite(kind) {
  return sprites.bg[kind] || null;
}

export function fruitFill(level) {
  return FRUIT_BODY_FILL[level] || 0.9;
}

export function zombieFill(level) {
  const i = Math.max(0, Math.min(ZOMBIE_BODY_FILL.length - 1, level | 0));
  return ZOMBIE_BODY_FILL[i];
}

/**
 * 以圆心 (x,y)、半径 r 绘制贴图：按 fill 放大后裁成正圆，视觉贴合物理球。
 * @returns {boolean} 是否成功画上贴图
 */
export function drawSprite(ctx, img, x, y, r, fill = 1) {
  if (!img) return false;
  const f = Math.max(0.65, Math.min(1, fill || 1));
  const s = Math.max(2, snap((r * 2) / f * SPRITE_BLEED));
  ctx.save();
  applyPixelCtx(ctx);
  ctx.beginPath();
  ctx.arc(snap(x), snap(y), Math.max(1, snap(r)), 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, snap(x - s / 2), snap(y - s / 2), s, s);
  ctx.restore();
  return true;
}
