/**
 * Node 侧的 wx / canvas 垫片 —— 只服务于 headless 自检与联机联调脚本。
 * 目标不是"能玩"，而是让模块能被 import、让纯逻辑（物理 / 快照 / 卡牌 / 排行榜）
 * 可以在 node 里跑起来。所有绘图 API 都是空实现。
 */
const store = new Map();

function stubCtx() {
  const noop = () => {};
  const ctx = {
    canvas: { width: 750, height: 1334 },
    measureText: (t) => ({ width: String(t).length * 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop,
    drawImage: noop,
    setTransform: noop
  };
  for (const k of [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo',
    'rect', 'roundRect', 'fill', 'stroke', 'fillRect', 'strokeRect', 'clearRect',
    'fillText', 'strokeText', 'translate', 'rotate', 'scale', 'clip', 'quadraticCurveTo',
    'bezierCurveTo', 'ellipse', 'setLineDash'
  ]) ctx[k] = noop;
  return ctx;
}

function stubCanvas(w = 750, h = 1334) {
  const c = {
    width: w,
    height: h,
    getContext: () => stubCtx(),
    toDataURL: () => '',
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  return c;
}

const wx = {
  getSystemInfoSync: () => ({
    windowWidth: 375, windowHeight: 667, pixelRatio: 2,
    screenWidth: 375, screenHeight: 667, platform: 'devtools',
    safeArea: { top: 0, bottom: 667, left: 0, right: 375 }
  }),
  createCanvas: () => stubCanvas(),
  createImage: () => ({ src: '', onload: null, onerror: null, width: 1, height: 1 }),
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  setStorageSync: (k, v) => { store.set(k, v); },
  removeStorageSync: (k) => { store.delete(k); },
  createInnerAudioContext: () => ({
    src: '', loop: false, volume: 1, autoplay: false,
    play() {}, stop() {}, pause() {}, destroy() {},
    onError() {}, onEnded() {}, offEnded() {}
  }),
  onTouchStart: () => {}, onTouchMove: () => {}, onTouchEnd: () => {}, onTouchCancel: () => {},
  onShow: () => {}, onHide: () => {},
  showToast: () => {}, hideToast: () => {},
  showModal: (o) => { if (o && o.success) o.success({ confirm: false }); },
  createRewardedVideoAd: () => null,
  triggerGC: () => {},
  setPreferredFramesPerSecond: () => {},
  getLaunchOptionsSync: () => ({ query: {} }),
  env: { USER_DATA_PATH: '.' }
};

globalThis.wx = wx;
globalThis.GameGlobal = globalThis;
globalThis.canvas = stubCanvas();
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

export { wx, stubCanvas, stubCtx, store };
