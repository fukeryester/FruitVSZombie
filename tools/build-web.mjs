/**
 * 网页版打包（GameHub 的 HTML 卡带）
 * ------------------------------------------------------------------
 * 产物：dist/fvz-mp.zip，解包后的目录结构就是站点直接托管的静态站：
 *   index.html          页面外壳 + 昵称输入浮层（来自 web/）
 *   wx-shim.js          微信小游戏 API → 浏览器（来自 web/）
 *   gamehub-room.js     房间 SDK 的包内兜底副本
 *   gamehub-stats.js    统计 / 成就 / 排行榜 SDK 的包内兜底副本
 *   game.js             入口（把小游戏写法的 './js/main' 补成 './js/main.js'）
 *   js/ audio/ Assets/  游戏本体
 *
 * 跑法：node tools/build-web.mjs
 */
import fs from 'fs';
import path from 'path';
import { writeZip } from './zip.mjs';

const root = path.resolve('.');
const OUT = path.join(root, 'dist', 'fvz-mp.zip');

/** 递归收集一个目录下的全部文件，返回 zip 条目（正斜杠相对路径） */
function collectDir(dir, prefix = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      out.push(...collectDir(p, prefix));
    } else {
      out.push({
        name: path.relative(root, p).split(path.sep).join('/'),
        data: fs.readFileSync(p)
      });
    }
  }
  return out;
}

const entries = [];

// ---- 外壳（web/ 下的文件平铺到包根） ----
for (const name of ['index.html', 'wx-shim.js', 'gamehub-room.js', 'gamehub-stats.js']) {
  const p = path.join(root, 'web', name);
  if (!fs.existsSync(p)) throw new Error('缺少 web/' + name);
  entries.push({ name, data: fs.readFileSync(p) });
}

// ---- 入口：补齐 ESM 需要的 .js 后缀 ----
// 小游戏的模块解析允许省略后缀，浏览器原生 ESM 不允许。
const gameJs = fs.readFileSync(path.join(root, 'game.js'), 'utf8')
  .replace(/from\s+'\.\/js\/main'/, "from './js/main.js'");
if (!/main\.js/.test(gameJs)) throw new Error('game.js 的入口路径没改成 ./js/main.js');
entries.push({ name: 'game.js', data: Buffer.from(gameJs, 'utf8') });

// ---- 游戏本体 ----
for (const dir of ['js', 'audio', 'Assets']) {
  entries.push(...collectDir(path.join(root, dir)));
}

// ---- 自检：别把测试脚手架和调试文件打进去 ----
const leaked = entries.filter((e) => /^(tools|_|dist)/.test(e.name));
if (leaked.length) throw new Error('包里混进了非游戏文件：' + leaked.map((e) => e.name).join(', '));

const size = writeZip(OUT, entries);
const totalRaw = entries.reduce((a, e) => a + e.data.length, 0);
console.log(`打包完成：${path.relative(root, OUT)}`);
console.log(`  条目 ${entries.length} 个，原始 ${(totalRaw / 1024 / 1024).toFixed(2)} MB → 压缩后 ${(size / 1024 / 1024).toFixed(2)} MB`);
for (const must of ['index.html', 'game.js', 'js/main.js', 'js/net/session.js', 'js/net/stageSync.js']) {
  if (!entries.some((e) => e.name === must)) throw new Error('包里缺少 ' + must);
}
console.log('  关键文件齐全（index.html / game.js / js/main.js / 联机层）');
