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

export const sprites = {
  fruits: [],
  zombies: [],
  core: null,
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
    loadOne(CORE_SRC)
  ]).then(([fruits, zombies, core]) => {
    sprites.fruits = fruits;
    sprites.zombies = zombies;
    sprites.core = core;
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

/**
 * 以圆心 (x,y)、半径 r 绘制贴图（关闭插值，尺寸/位置取整）。
 * @returns {boolean} 是否成功画上贴图
 */
export function drawSprite(ctx, img, x, y, r) {
  if (!img) return false;
  const s = Math.max(2, snap(r * 2));
  ctx.save();
  applyPixelCtx(ctx);
  ctx.drawImage(img, snap(x - s / 2), snap(y - s / 2), s, s);
  ctx.restore();
  return true;
}
