/**
 * 静态自检：把 js/ 下所有模块都 import 一遍。
 * 只要有语法错误、import 路径写错、或导出名拼错，这里就会炸。
 * （运行前先装好 wx 垫片，因为很多模块在顶层就摸 wx）
 */
import './wx-node-shim.mjs';
import fs from 'fs';
import path from 'path';
import url from 'url';

const root = path.resolve('js');
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files.sort()) {
  try {
    await import(url.pathToFileURL(f).href);
  } catch (e) {
    bad++;
    console.log('FAIL', path.relative('.', f), '\n   ', e.message.split('\n')[0]);
  }
}
console.log(`\n${files.length - bad}/${files.length} modules ok`);
process.exit(bad ? 1 : 0);
