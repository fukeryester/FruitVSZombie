(function (root) {
  function apiHeaders(token, json) {
    const headers = {};
    if (json) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  function wsUrl(token) {
    const proto = root.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL("/ws/rooms", proto + "//" + root.location.host);
    if (token) url.searchParams.set("token", token);
    return url.toString();
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

  class GameHubRoom {
    constructor(options) {
      options = options || {};
      this.token = options.token || "";
      this.ws = null;
      this.you = null;
      this.room = null;
      this._handlers = {};
    }

    on(event, fn) {
      this._handlers[event] = fn;
      return this;
    }

    _emit(event, payload) {
      const fn = this._handlers[event];
      if (fn) fn(payload);
    }

    _send(payload) {
      if (!this.ws || this.ws.readyState !== 1) {
        throw new Error("尚未连接房间服务");
      }
      this.ws.send(JSON.stringify(payload));
    }

    async createRoom(gameId, maxPlayers) {
      const body = { game_id: gameId };
      if (maxPlayers) body.max_players = maxPlayers;
      const data = await readJson(
        await fetch("/api/v1/rooms", {
          method: "POST",
          credentials: "same-origin",
          headers: apiHeaders(this.token, true),
          body: JSON.stringify(body),
        })
      );
      return data.room;
    }

    async listRooms(gameId) {
      const data = await readJson(
        await fetch("/api/v1/rooms?game_id=" + encodeURIComponent(gameId), {
          credentials: "same-origin",
          headers: apiHeaders(this.token, false),
        })
      );
      return data.rooms;
    }

    async getRoom(code) {
      const data = await readJson(
        await fetch("/api/v1/rooms/" + encodeURIComponent(code), {
          credentials: "same-origin",
          headers: apiHeaders(this.token, false),
        })
      );
      return data.room;
    }

    connect() {
      const self = this;
      return new Promise(function (resolve, reject) {
        if (self.ws && self.ws.readyState === 1) {
          resolve(self);
          return;
        }
        const socket = new WebSocket(wsUrl(self.token));
        self.ws = socket;
        socket.onopen = function () {
          resolve(self);
        };
        socket.onerror = function () {
          reject(new Error("无法连接房间服务"));
        };
        socket.onclose = function (event) {
          self._emit("close", { code: event.code });
        };
        socket.onmessage = function (event) {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          if (msg.op === "welcome") {
            self.you = msg.you;
            self.room = msg.room;
          }
          if (msg.op === "left") {
            self.you = null;
            self.room = null;
          }
          if (msg.room) self.room = msg.room;
          self._emit(msg.op, msg);
          if (msg.op === "error") self._emit("error", msg);
        };
      });
    }

    join(code) {
      this._send({ op: "join", room: code });
    }

    leave() {
      this._send({ op: "leave" });
    }

    broadcast(data) {
      this._send({ op: "broadcast", data: data });
    }

    send(clientId, data) {
      this._send({ op: "send", to: clientId, data: data });
    }

    ping() {
      this._send({ op: "ping" });
    }

    close() {
      if (this.ws) this.ws.close();
      this.ws = null;
      this.you = null;
      this.room = null;
    }
  }

  GameHubRoom.connect = function (options) {
    const session = new GameHubRoom(options);
    return session.connect();
  };

  root.GameHubRoom = GameHubRoom;
})(typeof window !== "undefined" ? window : globalThis);
