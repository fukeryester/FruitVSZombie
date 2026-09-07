/*
 * Browser adapter for the WeChat mini-game `wx` runtime.
 * ------------------------------------------------------------------
 * WeChat mini-games run inside 微信开发者工具 (WeChat DevTools), which is a
 * proprietary GUI only available on Windows/macOS. This adapter polyfills the
 * small slice of the `wx` global (plus canvas/audio/storage/touch) that this
 * game actually uses, so the exact same `js/` source can be previewed and
 * exercised in a normal desktop browser on Linux. It is a development-only
 * harness and is never packed into the shipped mini-game (see project.config.json
 * packOptions.ignore).
 *
 * Loaded as a classic script BEFORE the ES module bootstrap so that modules
 * which touch `wx` at import time (e.g. js/ui/assets.js -> preloadSprites) find
 * a ready global.
 */
(function () {
  'use strict';

  // Logical (design) viewport in CSS px. The game renders against a 750-wide
  // design space and scales to whatever windowWidth we report here.
  var WIN_W = 414;
  var WIN_H = 896;
  var DPR = 2;
  var SAFE_TOP = 44;

  var canvasEl = null;

  function ensureCanvas() {
    if (canvasEl) return canvasEl;
    canvasEl = document.getElementById('game-canvas');
    if (!canvasEl) {
      canvasEl = document.createElement('canvas');
      canvasEl.id = 'game-canvas';
      document.body.appendChild(canvasEl);
    }
    // Display the canvas at the logical size; the game sets the backing store
    // resolution (width/height) itself to WIN_W*DPR x WIN_H*DPR.
    canvasEl.style.width = WIN_W + 'px';
    canvasEl.style.height = WIN_H + 'px';
    return canvasEl;
  }

  // Rewrite package-relative asset paths ("Assets/...", "audio/...") to be
  // absolute from the web root so they resolve no matter where index.html lives.
  function rewritePath(v) {
    if (typeof v !== 'string' || !v) return v;
    if (/^(https?:|data:|blob:|\/)/i.test(v)) return v;
    return '/' + v.replace(/^\.\//, '');
  }

  // ---- storage: back wx sync storage with localStorage, preserving types ----
  function getStorageSync(key) {
    try {
      var raw = window.localStorage.getItem('wxms:' + key);
      if (raw === null) return '';
      try { return JSON.parse(raw); } catch (e) { return raw; }
    } catch (e) { return ''; }
  }
  function setStorageSync(key, value) {
    try { window.localStorage.setItem('wxms:' + key, JSON.stringify(value)); } catch (e) {}
  }

  // ---- images: real HTMLImageElement with path rewriting on `src` ----
  function createImage() {
    var img = new Image();
    var proto = Object.getPrototypeOf(img);
    var desc = Object.getOwnPropertyDescriptor(proto, 'src') ||
               Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(img, 'src', {
      configurable: true,
      enumerable: true,
      get: function () { return desc.get.call(img); },
      set: function (v) { desc.set.call(img, rewritePath(v)); }
    });
    return img;
  }

  // ---- audio: minimal InnerAudioContext over HTMLAudioElement ----
  function createInnerAudioContext() {
    var el = new Audio();
    var api = {
      _src: '',
      loop: false,
      volume: 1,
      autoplay: false,
      play: function () {
        try {
          el.loop = !!api.loop;
          el.volume = typeof api.volume === 'number' ? api.volume : 1;
          var p = el.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e) {}
      },
      stop: function () { try { el.pause(); el.currentTime = 0; } catch (e) {} },
      pause: function () { try { el.pause(); } catch (e) {} },
      destroy: function () { try { el.pause(); el.src = ''; } catch (e) {} },
      onError: function () {},
      onEnded: function () {}
    };
    Object.defineProperty(api, 'src', {
      get: function () { return api._src; },
      set: function (v) { api._src = v; el.src = rewritePath(v); }
    });
    return api;
  }

  // ---- system info ----
  function windowInfo() {
    return {
      windowWidth: WIN_W,
      windowHeight: WIN_H,
      screenWidth: WIN_W,
      screenHeight: WIN_H,
      pixelRatio: DPR,
      safeArea: { top: SAFE_TOP, left: 0, right: WIN_W, bottom: WIN_H }
    };
  }

  // ---- touch: fan browser pointer/touch events out to registered callbacks ----
  var touchStartCbs = [];
  var touchMoveCbs = [];
  var touchEndCbs = [];

  function toPoint(clientX, clientY, id) {
    var rect = ensureCanvas().getBoundingClientRect();
    var scaleX = rect.width ? WIN_W / rect.width : 1;
    var scaleY = rect.height ? WIN_H / rect.height : 1;
    var x = (clientX - rect.left) * scaleX;
    var y = (clientY - rect.top) * scaleY;
    return { x: x, y: y, clientX: x, clientY: y, pageX: x, pageY: y, identifier: id || 0 };
  }
  function emit(cbs, touches, changed) {
    var ev = { touches: touches, changedTouches: changed || touches };
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](ev); } catch (e) { console.error(e); } }
  }

  function bindInput() {
    var el = ensureCanvas();
    var mouseDown = false;

    el.addEventListener('mousedown', function (e) {
      mouseDown = true;
      var p = toPoint(e.clientX, e.clientY, 0);
      emit(touchStartCbs, [p], [p]);
    });
    window.addEventListener('mousemove', function (e) {
      if (!mouseDown) return;
      var p = toPoint(e.clientX, e.clientY, 0);
      emit(touchMoveCbs, [p], [p]);
    });
    window.addEventListener('mouseup', function (e) {
      if (!mouseDown) return;
      mouseDown = false;
      var p = toPoint(e.clientX, e.clientY, 0);
      emit(touchEndCbs, [], [p]);
    });

    function collect(list) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        out.push(toPoint(list[i].clientX, list[i].clientY, list[i].identifier));
      }
      return out;
    }
    el.addEventListener('touchstart', function (e) {
      e.preventDefault();
      emit(touchStartCbs, collect(e.touches), collect(e.changedTouches));
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      e.preventDefault();
      emit(touchMoveCbs, collect(e.touches), collect(e.changedTouches));
    }, { passive: false });
    el.addEventListener('touchend', function (e) {
      e.preventDefault();
      emit(touchEndCbs, collect(e.touches), collect(e.changedTouches));
    }, { passive: false });
  }

  // ---- modal (used by the reward-ad mock) ----
  function showModal(opts) {
    opts = opts || {};
    var msg = (opts.title ? opts.title + '\n\n' : '') + (opts.content || '');
    var confirmed = window.confirm(msg);
    if (opts.success) {
      try { opts.success({ confirm: confirmed, cancel: !confirmed }); } catch (e) { console.error(e); }
    }
    if (opts.complete) { try { opts.complete({}); } catch (e) {} }
  }

  // ---- stub rewarded video ad (unused while AD_UNIT_ID is empty) ----
  function createRewardedVideoAd() {
    return {
      onError: function () {}, onLoad: function () {}, onClose: function () {},
      load: function () { return Promise.resolve(); },
      show: function () { return Promise.resolve(); },
      destroy: function () {}
    };
  }

  var wx = {
    createCanvas: function () { return ensureCanvas(); },
    createImage: createImage,
    createInnerAudioContext: createInnerAudioContext,
    getWindowInfo: windowInfo,
    getSystemInfoSync: windowInfo,
    getStorageSync: getStorageSync,
    setStorageSync: setStorageSync,
    onTouchStart: function (cb) { touchStartCbs.push(cb); },
    onTouchMove: function (cb) { touchMoveCbs.push(cb); },
    onTouchEnd: function (cb) { touchEndCbs.push(cb); },
    showModal: showModal,
    showToast: function () {},
    createRewardedVideoAd: createRewardedVideoAd,
    getAccountInfoSync: function () {
      return { miniProgram: { envVersion: 'develop', appId: 'dev' } };
    },
    triggerGC: function () {},
    setPreferredFramesPerSecond: function () {}
  };

  window.wx = wx;
  globalThis.wx = wx;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindInput);
  } else {
    bindInput();
  }
})();
