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

/** 音效管理：分场景 BGM + 碰撞音效 */
const BGM_SRC = {
  lobby: 'audio/bgm-lobby.wav',
  merge: 'audio/bgm-merge.wav',
  zombie: 'audio/bgm-zombie.wav',
  resultFail: 'audio/bgm-result-fail.wav',
  resultWin: 'audio/bgm-result-win.wav'
};

export class AudioMgr {
  constructor() {
    this.enabled = storage.isSoundOn();
    this.ctxs = {};
    // 当前应当播放的 BGM 名（lobby/merge/zombie/...）。null 表示不该有 BGM。
    this.bgmWanted = null;
    this.bgmKey = null;
    for (const [key, src] of Object.entries(BGM_SRC)) {
      this._init(key, src, true, 0.4);
    }
    this._init('boom', 'audio/boom.wav', false, 0.9);
  }
  _init(key, src, loop, volume) {
    try {
      const c = wx.createInnerAudioContext();
      c.src = src;
      c.loop = loop;
      c.volume = volume;
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
  startBgm(name) {
    if (name) this.bgmWanted = name;
    if (!this.enabled || !this.bgmWanted) return;
    this._playBgm(this.bgmWanted);
  }
  /** 停止 BGM 并清除"应该有 BGM"标记（离开场景时调用） */
  stopBgm() {
    this.bgmWanted = null;
    this._stopBgmPlayback();
  }

  _playBgm(name) {
    if (this.bgmKey && this.bgmKey !== name) {
      const prev = this.ctxs[this.bgmKey];
      if (prev) { try { prev.stop(); } catch (e) {} }
    }
    this.bgmKey = name;
    const c = this.ctxs[name];
    if (c) {
      try { if (typeof c.seek === 'function') c.seek(0); } catch (e) {}
      c.play();
    }
  }

  /** 仅停止播放，不改变 bgmWanted（关闭音效开关时用） */
  _stopBgmPlayback() {
    if (this.bgmKey) {
      const c = this.ctxs[this.bgmKey];
      if (c) { try { c.stop(); } catch (e) {} }
      this.bgmKey = null;
    }
  }

  setEnabled(v) {
    this.enabled = v;
    storage.setSoundOn(v);
    if (v) {
      if (this.bgmWanted) this.startBgm();
    } else {
      this._stopBgmPlayback();
    }
  }
}
