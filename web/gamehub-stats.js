/* GameHub 统计 / 成就 / 排行榜 SDK。写入面对齐 Steamworks ISteamUserStats。
   用法：
     const gh = GameHubStats.connect();
     await gh.ready();                 // RequestCurrentStats
     gh.inc("puzzles_completed", 1);   // 只改内存
     gh.unlock("hard_perfect");
     gh.submit("hard_time", timeMs);
     await gh.store();                 // StoreStats，一次出网
   未登录时所有写操作是空操作，不影响游戏本地存档。不要每帧调用 store()。*/
(function (root) {
  const STORE_INTERVAL = 2000;

  function inferGameId() {
    const match = /^\/g\/([A-Za-z0-9_-]+)\/v\/[A-Za-z0-9_-]+\//.exec(root.location.pathname);
    if (match) return match[1];
    const param = new URLSearchParams(root.location.search).get("game_id");
    return param || root.GAMEHUB_GAME_ID || "";
  }

  async function readJson(response) {
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = new Error(body.error || "请求失败");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  class GameHubStats {
    constructor(options) {
      options = options || {};
      this.gameId = options.gameId || inferGameId();
      this.token = options.token || "";
      this.base = "/api/v1/games/" + encodeURIComponent(this.gameId);
      this.enabled = false;
      this.loaded = false;
      this.defs = { stats: [], achievements: [], leaderboards: [] };
      this.values = {};
      this.unlocked = {};
      this._pending = { set: {}, inc: {}, unlock: [], submit: {} };
      this._handlers = {};
      this._lastStore = 0;
      this._timer = null;
      this._inflight = null;
      this._readyPromise = null;
      this._bindLifecycle();
    }

    on(event, fn) {
      (this._handlers[event] = this._handlers[event] || []).push(fn);
      return this;
    }

    _emit(event, payload) {
      (this._handlers[event] || []).forEach((fn) => {
        try {
          fn(payload);
        } catch (error) {
          console.warn("[gamehub-stats]", error);
        }
      });
    }

    _headers(json) {
      const headers = {};
      if (json) headers["Content-Type"] = "application/json";
      if (this.token) headers.Authorization = "Bearer " + this.token;
      return headers;
    }

    ready() {
      if (this._readyPromise) return this._readyPromise;
      this._readyPromise = (async () => {
        if (!this.gameId) {
          this._emit("error", new Error("无法推断 game_id，请用 GameHubStats.connect({ gameId })"));
          return this;
        }
        try {
          const data = await readJson(
            await fetch(this.base + "/stats/me", { credentials: "same-origin", headers: this._headers(false) })
          );
          this.defs = {
            stats: data.stats || [],
            achievements: data.achievements || [],
            leaderboards: data.leaderboards || [],
          };
          this.values = {};
          (data.stats || []).forEach((stat) => {
            this.values[stat.id] = stat.value;
          });
          (data.achievements || []).forEach((item) => {
            if (item.unlocked) this.unlocked[item.id] = true;
          });
          this.enabled = !!data.logged_in;
          this.loaded = true;
          this._emit("ready", this);
        } catch (error) {
          this.enabled = false;
          this._emit("error", error);
        }
        return this;
      })();
      return this._readyPromise;
    }

    statDef(name) {
      return this.defs.stats.find((stat) => stat.id === name) || null;
    }

    get(name) {
      if (name in this.values) return this.values[name];
      const def = this.statDef(name);
      return def ? def.default : 0;
    }

    set(name, value) {
      const number = Number(value);
      if (!isFinite(number)) return this;
      this.values[name] = number;
      this._pending.set[name] = number;
      delete this._pending.inc[name];
      return this;
    }

    inc(name, delta) {
      const step = Number(delta === undefined ? 1 : delta);
      if (!isFinite(step) || step === 0) return this;
      this.values[name] = this.get(name) + step;
      if (name in this._pending.set) this._pending.set[name] = this.values[name];
      else this._pending.inc[name] = (this._pending.inc[name] || 0) + step;
      return this;
    }

    unlock(name) {
      if (this.unlocked[name] || this._pending.unlock.includes(name)) return this;
      this._pending.unlock.push(name);
      return this;
    }

    submit(boardId, score, extras) {
      const number = Number(score);
      if (!isFinite(number)) return this;
      this._pending.submit[boardId] = extras === undefined ? { score: number } : { score: number, extras: extras };
      return this;
    }

    achievement(name) {
      return this.defs.achievements.find((item) => item.id === name) || null;
    }

    _hasPending() {
      const p = this._pending;
      return (
        Object.keys(p.set).length > 0 ||
        Object.keys(p.inc).length > 0 ||
        p.unlock.length > 0 ||
        Object.keys(p.submit).length > 0
      );
    }

    _takePending() {
      const payload = this._pending;
      this._pending = { set: {}, inc: {}, unlock: [], submit: {} };
      return payload;
    }

    _restore(payload) {
      const p = this._pending;
      this._pending = {
        set: Object.assign({}, payload.set, p.set),
        inc: Object.assign({}, payload.inc, p.inc),
        unlock: payload.unlock.concat(p.unlock.filter((id) => !payload.unlock.includes(id))),
        submit: Object.assign({}, payload.submit, p.submit),
      };
    }

    /** StoreStats。超过限流窗口时自动排队，不会丢数据。 */
    store(options) {
      const keepalive = !!(options && options.keepalive);
      if (!this.enabled || !this._hasPending()) return Promise.resolve(null);
      if (this._inflight) return this._inflight.then(() => this.store(options));
      const wait = STORE_INTERVAL - (Date.now() - this._lastStore);
      if (wait > 0 && !keepalive) return this._schedule(wait);
      const payload = this._takePending();
      this._lastStore = Date.now();
      this._inflight = (async () => {
        try {
          const result = await readJson(
            await fetch(this.base + "/stats", {
              method: "POST",
              credentials: "same-origin",
              keepalive: keepalive,
              headers: this._headers(true),
              body: JSON.stringify(payload),
            })
          );
          this._applyResult(result);
          return result;
        } catch (error) {
          this._restore(payload);
          if (error.status === 429) this._schedule(STORE_INTERVAL);
          else this._emit("error", error);
          return null;
        } finally {
          this._inflight = null;
        }
      })();
      return this._inflight;
    }

    _schedule(delay) {
      if (this._timer) return Promise.resolve(null);
      return new Promise((resolve) => {
        this._timer = setTimeout(() => {
          this._timer = null;
          resolve(this.store());
        }, Math.max(50, delay));
      });
    }

    _applyResult(result) {
      if (!result) return;
      if (result.stats) Object.assign(this.values, result.stats);
      (result.unlocked || []).forEach((id) => {
        this.unlocked[id] = true;
        const detail = (result.achievement_details || []).find((item) => item.id === id) || this.achievement(id) || { id: id };
        this._emit("achievement", detail);
        this._notifyParent(detail);
      });
      this._emit("store", result);
    }

    _notifyParent(achievement) {
      if (root.parent === root) return;
      try {
        root.parent.postMessage(
          { type: "gamehub-achievement", game_id: this.gameId, achievement: achievement },
          root.location.origin
        );
      } catch (error) {
        /* 父页面可能不同源，忽略 */
      }
    }

    async board(boardId, limit) {
      const url = this.base + "/leaderboards/" + encodeURIComponent(boardId) + (limit ? "?limit=" + limit : "");
      const data = await readJson(await fetch(url, { credentials: "same-origin", headers: this._headers(false) }));
      return data.leaderboard;
    }

    async display() {
      const data = await readJson(
        await fetch(this.base + "/display", { credentials: "same-origin", headers: this._headers(false) })
      );
      return data;
    }

    _bindLifecycle() {
      const flush = () => {
        if (this._hasPending()) this.store({ keepalive: true });
      };
      root.addEventListener("pagehide", flush);
      root.document.addEventListener("visibilitychange", () => {
        if (root.document.visibilityState === "hidden") flush();
      });
    }
  }

  GameHubStats.connect = function (options) {
    const session = new GameHubStats(options);
    session.ready();
    return session;
  };

  root.GameHubStats = GameHubStats;
})(typeof window !== "undefined" ? window : globalThis);
