/**
 * 微信小游戏 API → 浏览器 的适配垫片（网页版专用）
 * ------------------------------------------------------------------
 * 游戏本体是按微信小游戏 API 写的，这一层把它需要的那部分映射到浏览器：
 *   画布 / 触摸 / 存储 / 音频 / 弹窗 / 剪贴板 / 激励视频（降级）。
 *
 * 联机版新增的两件事：
 *   · wx.promptText —— 昵称输入。排行榜以昵称为主键、联机时也是名牌，
 *     canvas 里没法调起输入法，所以用 index.html 里那层 HTML 输入框实现。
 *   · window.GameHubRoom 的兜底加载 —— 站点 /static/gamehub-room.js
 *     取不到时（本地起服务调试），从包内同名文件补上。
 */
(function () {
  const stage = document.getElementById('stage');
  const canvas = document.createElement('canvas');
  stage.insertBefore(canvas, stage.firstChild);

  function viewSize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, stage.clientWidth || window.innerWidth);
    const h = Math.max(1, stage.clientHeight || window.innerHeight);
    return {
      windowWidth: w,
      windowHeight: h,
      screenWidth: w,
      screenHeight: h,
      pixelRatio: dpr,
      safeArea: { top: 0, left: 0, right: w, bottom: h }
    };
  }

  function pointsFromEvent(e, kind) {
    const rect = canvas.getBoundingClientRect();
    const src = kind === 'end'
      ? (e.changedTouches && e.changedTouches.length ? e.changedTouches : [e])
      : (e.touches && e.touches.length ? e.touches : (e.changedTouches || [e]));
    return Array.from(src).map((t) => {
      const cx = (t.clientX != null ? t.clientX : e.clientX) - rect.left;
      const cy = (t.clientY != null ? t.clientY : e.clientY) - rect.top;
      return {
        x: cx,
        y: cy,
        clientX: cx,
        clientY: cy,
        identifier: t.identifier != null ? t.identifier : 0
      };
    });
  }

  const cbs = { start: [], move: [], end: [] };
  function emit(kind, e) {
    // 昵称输入浮层打开时，画布不该再收到点击（否则会误触发投放）
    if (promptOpen) return;
    e.preventDefault();
    const pts = pointsFromEvent(e, kind);
    const payload = { touches: pts, changedTouches: pts };
    cbs[kind].forEach((fn) => fn(payload));
  }

  canvas.addEventListener('touchstart', (e) => emit('start', e), { passive: false });
  canvas.addEventListener('touchmove', (e) => emit('move', e), { passive: false });
  canvas.addEventListener('touchend', (e) => emit('end', e), { passive: false });
  canvas.addEventListener('touchcancel', (e) => emit('end', e), { passive: false });
  canvas.addEventListener('mousedown', (e) => emit('start', e));
  window.addEventListener('mousemove', (e) => {
    if (e.buttons) emit('move', e);
  });
  window.addEventListener('mouseup', (e) => emit('end', e));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------- 昵称输入浮层 ----------------
  let promptOpen = false;
  const el = {
    root: document.getElementById('prompt'),
    title: document.getElementById('prompt-title'),
    tip: document.getElementById('prompt-tip'),
    input: document.getElementById('prompt-input'),
    ok: document.getElementById('prompt-ok'),
    cancel: document.getElementById('prompt-cancel')
  };
  let pendingResolve = null;

  function closePrompt(value) {
    if (!promptOpen) return;
    promptOpen = false;
    el.root.classList.remove('on');
    el.input.blur();
    const done = pendingResolve;
    pendingResolve = null;
    if (done) done(value);
  }

  if (el.root) {
    el.ok.addEventListener('click', () => closePrompt(el.input.value));
    el.cancel.addEventListener('click', () => closePrompt(null));
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') closePrompt(el.input.value);
      if (e.key === 'Escape') closePrompt(null);
    });
  }

  /**
   * 弹出文本输入。
   * @returns {Promise<string|null>} 取消返回 null
   */
  function promptText(opts) {
    opts = opts || {};
    if (!el.root) return Promise.resolve(null);
    // 上一个还没关就先取消掉，避免两个 Promise 都挂着
    if (promptOpen) closePrompt(null);
    el.title.textContent = opts.title || '请输入';
    el.tip.textContent = opts.tip || '';
    el.input.maxLength = opts.maxLength || 12;
    el.input.placeholder = opts.placeholder || '';
    el.input.value = opts.value || '';
    promptOpen = true;
    el.root.classList.add('on');
    return new Promise((resolve) => {
      pendingResolve = resolve;
      setTimeout(() => {
        el.input.focus();
        el.input.select();
      }, 30);
    });
  }

  // ---------------- 房间 SDK 兜底 ----------------
  // index.html 里已经先试过站点版本；这里在它缺失时补上包内副本。
  if (!window.GameHubRoom) {
    const s = document.createElement('script');
    s.src = './gamehub-room.js';
    document.head.appendChild(s);
  }

  window.wx = {
    createCanvas() { return canvas; },
    createImage() { return new Image(); },
    getWindowInfo: viewSize,
    getSystemInfoSync: viewSize,
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'release' } };
    },
    getStorageSync(key) {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return '';
        return JSON.parse(raw);
      } catch (e) {
        return '';
      }
    },
    setStorageSync(key, val) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch (e) {
        /* 隐私模式下写不进去，本次运行内仍可玩 */
      }
    },
    removeStorageSync(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) { /* ignore */ }
    },
    onTouchStart(fn) { cbs.start.push(fn); },
    onTouchMove(fn) { cbs.move.push(fn); },
    onTouchEnd(fn) { cbs.end.push(fn); },
    createInnerAudioContext() {
      const a = new Audio();
      a.preload = 'auto';
      return {
        set src(v) { a.src = v; },
        get src() { return a.src; },
        set loop(v) { a.loop = !!v; },
        get loop() { return a.loop; },
        set volume(v) { a.volume = v; },
        get volume() { return a.volume; },
        play() { const p = a.play(); if (p && p.catch) p.catch(function () {}); },
        stop() { try { a.pause(); a.currentTime = 0; } catch (e) {} },
        seek(t) { try { a.currentTime = t || 0; } catch (e) {} }
      };
    },
    showModal(opts) {
      const ok = window.confirm(((opts && opts.title) || '') + '\n' + ((opts && opts.content) || ''));
      if (opts && opts.success) opts.success({ confirm: ok, cancel: !ok });
    },
    promptText,
    openUrl(opts) {
      if (opts && opts.url) window.open(opts.url, '_blank', 'noopener');
    },
    setClipboardData(opts) {
      const data = (opts && opts.data) || '';
      const ok = () => { if (opts && opts.success) opts.success(); };
      const fail = () => { if (opts && opts.fail) opts.fail(); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data).then(ok).catch(fail);
      } else {
        ok();
      }
    },
    createRewardedVideoAd() {
      return {
        onError() {},
        onLoad() {},
        onClose() {},
        show() { return Promise.reject(new Error('no-ad')); },
        load() { return Promise.resolve(); },
        destroy() {}
      };
    }
  };

  window.GameGlobal = window;
})();
