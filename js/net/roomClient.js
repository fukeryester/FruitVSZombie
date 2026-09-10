/**
 * GameHub 房间客户端
 * ------------------------------------------------------------------
 * 对站点提供的 `/static/gamehub-room.js` SDK 做一层封装，补上游戏侧真正
 * 需要的东西：
 *   · 运行环境探测（微信小游戏 / 无头测试里没有 window，直接判定不支持）；
 *   · SDK 动态加载（先用站点版本，取不到再回退包内自带的同名文件）；
 *   · 发送限流（服务端约 20 条/秒）：关键报文排队必达，快照类报文超额即丢；
 *   · 心跳与断线通知。
 *
 * 鉴权完全依赖同域 Cookie —— 游戏是在已登录站点的 `/g/{id}/v/{vid}/index.html`
 * 里跑的，fetch 与 WebSocket 都会自动带上会话。**不要**把 API Token 写进包里。
 */
import { SEND_BUDGET_PER_SEC, PING_INTERVAL_MS, MAX_PACKET_BYTES } from '../config/net.js';

/** 站点 SDK 路径；取不到时回退到包内自带的副本 */
const SDK_URLS = ['/static/gamehub-room.js', './gamehub-room.js'];

/** 被测试注入的 SDK 构造器（正常运行时恒为 null，见 __setSdkFactory） */
let _forcedSdk = null;

/** 当前环境是否具备联机能力（微信小游戏包返回 false；测试注入 SDK 后返回 true） */
export function isNetSupported() {
  if (_forcedSdk) return true;
  return typeof window !== 'undefined' &&
    typeof window.WebSocket === 'function' &&
    typeof window.fetch === 'function' &&
    typeof document !== 'undefined';
}

/**
 * 解析当前游戏在 GameHub 上的 id。
 * 游玩地址形如 `/g/{game_id}/v/{version_id}/index.html`，同域 iframe 里可以自己拆。
 * 本地调试时允许用 `?game_id=` 覆盖。
 * @returns {string} 取不到时返回空串
 */
export function detectGameId() {
  if (typeof window === 'undefined') return '';
  try {
    const q = new URLSearchParams(window.location.search).get('game_id');
    if (q) return q;
    const m = window.location.pathname.match(/\/g\/([0-9a-f]{8,})\//i);
    if (m) return m[1];
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts[1] || '';
  } catch (e) {
    return '';
  }
}

let sdkPromise = null;

/**
 * 测试注入点：把房间 SDK 换成进程内的模拟实现（见 tools/mock-hub.mjs），
 * 这样四端联调、限流、8KB 上限都能在 node 里无头跑一遍。
 * 传 null 恢复真实加载逻辑。
 * @param {Function|null} ctor GameHubRoom 兼容的构造器
 */
export function __setSdkFactory(ctor) {
  sdkPromise = ctor ? Promise.resolve(ctor) : null;
  _forcedSdk = ctor || null;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('load fail: ' + src));
    document.head.appendChild(el);
  });
}

/** 加载房间 SDK，成功后返回 window.GameHubRoom 构造器 */
export async function loadRoomSdk() {
  if (_forcedSdk) return _forcedSdk;
  if (!isNetSupported()) return null;
  if (window.GameHubRoom) return window.GameHubRoom;
  if (!sdkPromise) {
    sdkPromise = (async () => {
      for (const url of SDK_URLS) {
        try {
          await injectScript(url);
        } catch (e) {
          continue;
        }
        if (window.GameHubRoom) return window.GameHubRoom;
      }
      return null;
    })();
  }
  return sdkPromise;
}

/**
 * 房间连接。事件通过 on(name, fn) 订阅，可多个订阅者（SDK 本身只支持一个）。
 * 事件：welcome / message / member_joined / member_left / left / error / close
 */
export class RoomClient {
  constructor() {
    this.sdk = null;
    this.room = null;     // GameHubRoom 实例
    this.you = null;      // { client_id, user_id, username, seat }
    this.info = null;     // 房间快照 { code, host_id, max_players, members }
    this._listeners = new Map();
    this._tokens = SEND_BUDGET_PER_SEC;
    this._tokenAt = Date.now();
    this._queue = [];     // 关键报文积压队列
    this._pingTimer = null;
    this.lastError = '';
  }

  get connected() {
    return !!(this.room && this.room.ws && this.room.ws.readyState === 1);
  }

  get joined() {
    return !!(this.connected && this.info);
  }

  on(name, fn) {
    const arr = this._listeners.get(name) || [];
    arr.push(fn);
    this._listeners.set(name, arr);
    return this;
  }

  off(name, fn) {
    const arr = this._listeners.get(name);
    if (!arr) return this;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    return this;
  }

  _emit(name, payload) {
    const arr = this._listeners.get(name);
    if (!arr) return;
    for (const fn of arr.slice()) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[net] listener', name, e);
      }
    }
  }

  /** 建立 WebSocket 连接（幂等） */
  async connect() {
    if (this.connected) return true;
    this.sdk = await loadRoomSdk();
    if (!this.sdk) {
      this.lastError = '联机组件加载失败';
      return false;
    }
    const room = new this.sdk();
    for (const op of ['welcome', 'message', 'member_joined', 'member_left', 'left', 'pong']) {
      room.on(op, (m) => this._onServer(op, m));
    }
    room.on('error', (m) => {
      this.lastError = (m && m.error) || '房间服务异常';
      this._emit('error', m);
    });
    room.on('close', (m) => {
      this._stopPing();
      this.info = null;
      this._emit('close', m);
    });
    try {
      await room.connect();
    } catch (e) {
      this.lastError = (e && e.message) || '无法连接房间服务';
      return false;
    }
    this.room = room;
    this._startPing();
    return true;
  }

  _onServer(op, msg) {
    if (op === 'welcome') {
      this.you = msg.you;
      this.info = msg.room;
    } else if (op === 'left') {
      this.info = null;
    } else if (msg && msg.room) {
      this.info = msg.room;
    }
    this._emit(op, msg);
  }

  _startPing() {
    this._stopPing();
    if (typeof setInterval !== 'function') return;
    this._pingTimer = setInterval(() => {
      if (!this.connected) return;
      try {
        this.room.ping();
      } catch (e) {
        /* 断线由 close 事件处理 */
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  /** 创建房间（REST），失败抛出带 message 的 Error */
  async createRoom(gameId, maxPlayers) {
    const sdk = this.sdk || (await loadRoomSdk());
    if (!sdk) throw new Error('联机组件加载失败');
    const probe = this.room || new sdk();
    return probe.createRoom(gameId, maxPlayers);
  }

  /** 列出该游戏当前的房间 */
  async listRooms(gameId) {
    const sdk = this.sdk || (await loadRoomSdk());
    if (!sdk) throw new Error('联机组件加载失败');
    const probe = this.room || new sdk();
    return probe.listRooms(gameId);
  }

  join(code) {
    if (!this.connected) throw new Error('尚未连接房间服务');
    this.room.join(String(code || '').trim().toUpperCase());
  }

  leave() {
    if (!this.connected) return;
    try {
      this.room.leave();
    } catch (e) {
      /* 已经断了就算了 */
    }
    this.info = null;
  }

  close() {
    this._stopPing();
    this._queue.length = 0;
    if (this.room) {
      try {
        this.room.close();
      } catch (e) {
        /* ignore */
      }
    }
    this.room = null;
    this.info = null;
    this.you = null;
  }

  // ---------------- 发送（限流） ----------------

  _refill() {
    const now = Date.now();
    const dt = (now - this._tokenAt) / 1000;
    if (dt <= 0) return;
    this._tokenAt = now;
    this._tokens = Math.min(SEND_BUDGET_PER_SEC, this._tokens + dt * SEND_BUDGET_PER_SEC);
  }

  /**
   * 发送一条报文。
   * @param {object} data 报文体（会被 JSON 序列化）
   * @param {object} [opts] { critical 关键报文（超额时排队而不是丢弃）, to 单播的 client_id }
   * @returns {boolean} 是否已真正投递（排队也算 false）
   */
  send(data, opts = {}) {
    if (!this.joined) return false;
    const payload = { data, to: opts.to || null };
    if (opts.critical) {
      this._queue.push(payload);
      this.flush();
      return true;
    }
    this._refill();
    if (this._tokens < 1) return false;
    return this._deliver(payload);
  }

  /** 把积压的关键报文尽量发出去（每帧调用） */
  flush() {
    if (!this._queue.length || !this.joined) return;
    this._refill();
    while (this._queue.length && this._tokens >= 1) {
      this._deliver(this._queue.shift());
    }
  }

  _deliver(payload) {
    let text;
    try {
      text = JSON.stringify(payload.data);
    } catch (e) {
      return false;
    }
    if (text.length > MAX_PACKET_BYTES) {
      console.warn('[net] 报文过大已丢弃', text.length);
      return false;
    }
    this._tokens -= 1;
    try {
      if (payload.to) this.room.send(payload.to, payload.data);
      else this.room.broadcast(payload.data);
      return true;
    } catch (e) {
      this.lastError = (e && e.message) || '发送失败';
      return false;
    }
  }
}
