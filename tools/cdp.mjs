/**
 * 无头浏览器驱动（CDP）
 * ------------------------------------------------------------------
 * 给浏览器端自检用的最小封装：启动 Edge/Chrome、接管页面、在页面里求值、
 * 按**游戏设计坐标**点击、截图、收集控制台报错与未捕获异常。
 *
 * 为什么一个玩家一个浏览器实例
 * ------------------------------------------------------------------
 * 一开始两个玩家开在同一个浏览器的两个标签页里，结果后台标签的
 * requestAnimationFrame 被节流到近乎停摆 —— 房主那页一旦失去前台就不再步进
 * 物理、也不再发快照，整局看起来就"卡住"了（headless 下
 * --disable-background-timer-throttling 之类的开关并不管用）。各开一个实例，
 * 两边都是前台页，顺带也更接近"两台设备各开一份"的真实情形。
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本机可用的浏览器可执行文件；找不到返回空串 */
export function findBrowser() {
  return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || '';
}

const browsers = [];

/** 关掉本模块启动过的所有浏览器，并尽量清掉临时 profile */
export async function closeBrowsers() {
  for (const b of browsers) {
    try { b.proc.kill(); } catch (e) { /* ignore */ }
  }
  await sleep(800);
  for (const b of browsers) {
    // 浏览器退出后句柄有延迟才释放，删不掉就留给下次启动时清
    try { fs.rmSync(b.profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  browsers.length = 0;
}

/**
 * 起一个无头浏览器实例并打开 url。
 * @returns {Promise<{tag:string, port:number, proc:object, profile:string}|null>}
 */
export async function launchBrowser(tag, port, url) {
  const exe = findBrowser();
  if (!exe) return null;
  const profile = path.resolve(`_webtest-profile-${tag}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const proc = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=430,932',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    url
  ], { stdio: 'ignore' });
  const inst = { tag, port, proc, profile };
  browsers.push(inst);
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return inst;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  return null;
}

/** 一个受控页面 */
export class Tab {
  constructor(name) {
    this.name = name;
    this.errors = [];
    this.exceptions = [];
    this._id = 0;
    this._waiting = new Map();
  }

  /** 接管某个浏览器实例里第一个匹配 urlPattern 的页面 */
  static async attach(name, port, urlPattern = /index\.html/) {
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && urlPattern.test(t.url || ''));
      if (page && page.webSocketDebuggerUrl) {
        const tab = new Tab(name);
        await tab._attach(page.webSocketDebuggerUrl);
        return tab;
      }
      await sleep(250);
    }
    return null;
  }

  async _attach(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (ev) => this._onMessage(JSON.parse(ev.data));
    await this.cdp('Runtime.enable');
    await this.cdp('Log.enable');
    await this.cdp('Page.enable');
  }

  _onMessage(msg) {
    if (msg.id && this._waiting.has(msg.id)) {
      this._waiting.get(msg.id)(msg);
      this._waiting.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      this.errors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.exceptions.push((d.exception && d.exception.description) || d.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const e = msg.params.entry;
      if (!/favicon/.test(e.url || '')) this.errors.push(e.text + ' <- ' + (e.url || '?'));
    }
    if (msg.method === 'Page.loadEventFired' && this._onLoad) this._onLoad();
  }

  cdp(method, params = {}) {
    const id = ++this._id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => this._waiting.set(id, r));
  }

  /**
   * 给这个页面之后发出的所有请求附加固定头。
   * 线上站点是 Cookie 会话鉴权，浏览器导航没法自己带 Authorization，
   * 自检里就靠这个把 API Token 挂上去，才能以登录身份打开游玩地址。
   */
  async setHeaders(headers) {
    await this.cdp('Network.enable');
    await this.cdp('Network.setExtraHTTPHeaders', { headers });
  }

  /** 导航并等到 load 事件（或超时） */
  async goto(url, ms = 20000) {
    const done = new Promise((resolve) => {
      this._onLoad = resolve;
      setTimeout(resolve, ms);
    });
    await this.cdp('Page.navigate', { url });
    await done;
    this._onLoad = null;
    this._geom = null;
  }

  async eval(expr) {
    const r = await this.cdp('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    const res = r.result && r.result.result;
    if (r.result && r.result.exceptionDetails) {
      this.exceptions.push(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 60));
    }
    return res ? res.value : undefined;
  }

  /**
   * 在游戏上下文里求值（g = Main 实例，见 main.js 里的 GameGlobal.game）。
   * 页面刷新途中 g 还不存在，取值失败一律返回 undefined —— 自检自己的探针
   * 不该被记成"页面未捕获异常"。
   */
  probe(expr) {
    return this.eval(`(() => {
      try {
        const g = GameGlobal.game;
        if (!g) return undefined;
        return (${expr});
      } catch (e) { return undefined; }
    })()`);
  }

  stateName() {
    return this.probe('g.states.current && g.states.current.constructor.name');
  }

  /** 轮询直到表达式为真 */
  async waitFor(expr, ms = 6000) {
    const till = Date.now() + ms;
    while (Date.now() < till) {
      if (await this.probe(expr)) return true;
      await sleep(200);
    }
    return false;
  }

  /** 画布几何：把游戏内的 750 宽设计坐标换算成页面坐标 */
  async geom() {
    const g = await this.eval(`(() => {
      const c = document.querySelector('#stage canvas') || document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    })()`);
    if (!g) return null;
    this._geom = g;
    this._scale = g.w / 750;
    this._designH = g.h / this._scale;
    return g;
  }

  get designH() { return this._designH; }

  /** 按设计坐标点一下 */
  async tap(dx, dy) {
    if (!this._geom) await this.geom();
    const x = Math.round(this._geom.left + dx * this._scale);
    const y = Math.round(this._geom.top + dy * this._scale);
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  }

  /** 画布上出现了多少种颜色 —— 用来判断"确实画出了东西" */
  colors(stride = 53) {
    return this.eval(`(() => {
      const c = document.querySelector('#stage canvas') || document.querySelector('canvas');
      if (!c) return 0;
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const s = new Set();
      for (let i = 0; i < d.length; i += 4 * ${stride}) s.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      return s.size;
    })()`);
  }

  /** 截图存盘；返回是否拿到了像样的图 */
  async shot(file) {
    const r = await this.cdp('Page.captureScreenshot', { format: 'png' });
    if (!r.result || !r.result.data) return false;
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return fs.statSync(file).size > 5000;
  }

  /** 预置昵称：写入存储后刷新页面，让 Main 在构造时读到它 */
  async setName(name) {
    for (let i = 0; i < 40; i++) {
      if (await this.eval('typeof wx === "object" && !!wx.setStorageSync')) break;
      await sleep(200);
    }
    await this.eval(`wx.setStorageSync('fvz_player_name', ${JSON.stringify(name)})`);
    await this.cdp('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 60; i++) {
      if ((await this.probe(`g.playerName === ${JSON.stringify(name)}`)) === true) return true;
      await sleep(200);
    }
    return false;
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}
