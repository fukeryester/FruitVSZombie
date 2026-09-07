/** 通用工具：随机、截断、本地存储、音效管理 */

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function pickN(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

/** 随机抽取一半（向上取整）：卡牌"大丰收"与复活清场共用 */
export function pickHalf(arr) {
  return pickN(arr, Math.ceil(arr.length / 2));
}

/**
 * 随机抽取一半，但排除"当前等级最高"的元素：
 * 卡牌"大丰收"与看广告复活清场都用它——场上最高等级的水果不参与消失。
 * @param {Array} arr 元素需带 level 字段（球体）
 * @returns {Array} 被选中将被移除的元素（全是低于最高等级的）
 */
export function pickHalfExcludingMax(arr) {
  if (!arr.length) return [];
  let maxLevel = -Infinity;
  for (const b of arr) if (b.level > maxLevel) maxLevel = b.level;
  const pool = arr.filter(b => b.level < maxLevel);
  if (!pool.length) return []; // 全场都是最高等级 → 一个都不消
  return pickHalf(pool);
}

/** 洗牌式受控随机：保证前 poolSize 等出现，低等级权重更高 */
export function weightedLevelIndex(poolSize) {
  const w = [];
  for (let i = 0; i < poolSize; i++) w.push(poolSize - i);
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) return i;
  }
  return 0;
}

const KEY_BEST = 'suika_best_score';
const KEY_SOUND = 'suika_sound_on';

export const storage = {
  getBest() {
    return wx.getStorageSync(KEY_BEST) || 0;
  },
  setBest(v) {
    wx.setStorageSync(KEY_BEST, v);
  },
  isSoundOn() {
    const v = wx.getStorageSync(KEY_SOUND);
    return v === '' ? true : !!v; // 默认开
  },
  setSoundOn(v) {
    wx.setStorageSync(KEY_SOUND, v);
  }
};

/** 音效管理：复用 audio/ 目录现有素材 */
export class AudioMgr {
  constructor() {
    this.enabled = storage.isSoundOn();
    this.ctxs = {};
    // BGM 是否"应该"在播（局内进入时置 true，退出局内置 false）。
    // 与 enabled 分开记录，才能在关掉音效再打开时恢复背景音乐。
    this.bgmWanted = false;
    this._init('bgm', 'audio/bgm.mp3', true);
    this._init('boom', 'audio/boom.mp3', false);
  }
  _init(key, src, loop) {
    try {
      const c = wx.createInnerAudioContext();
      c.src = src;
      c.loop = loop;
      c.volume = loop ? 0.4 : 0.9;
      this.ctxs[key] = c;
    } catch (e) {
      // 音频创建失败不阻塞游戏
    }
  }
  play(key) {
    if (!this.enabled) return;
    const c = this.ctxs[key];
    if (!c) return;
    if (c.loop) return; // 循环音轨用 start/stop
    try { c.stop(); } catch (e) {}
    c.play();
  }
  startBgm() {
    this.bgmWanted = true;
    if (!this.enabled) return;
    const c = this.ctxs.bgm;
    if (c) c.play();
  }
  /** 停止 BGM 并清除"应该有 BGM"标记（离开局内时调用） */
  stopBgm() {
    this.bgmWanted = false;
    this._stopBgmPlayback();
  }

  /** 仅停止播放，不改变 bgmWanted（关闭音效开关时用） */
  _stopBgmPlayback() {
    const c = this.ctxs.bgm;
    if (c) { try { c.stop(); } catch (e) {} }
  }

  setEnabled(v) {
    this.enabled = v;
    storage.setSoundOn(v);
    if (v) {
      // 重新开启音效：若当前处于"应该有 BGM"的场景（局内），立即恢复播放
      if (this.bgmWanted) this.startBgm();
    } else {
      this._stopBgmPlayback(); // 只停播放，保留 bgmWanted，便于再次开启时恢复
    }
  }
}
