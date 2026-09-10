/**
 * 把 assets/achievements/ 下的图标传到 GameHub。
 *
 *   node tools/upload-icons.mjs <token>
 *
 * 用的是 POST /api/v1/projects/{id}/achievements/{ach}/icon，服务端会自动把 URL
 * 回填进成就定义，所以不用（也不该）在 progression.json 里手写图标路径。
 * Token 只从命令行或 GH_TOKEN 读，不进游戏包。
 */
import fs from 'fs';
import path from 'path';

const HOST = process.env.GH_HOST || 'http://101.43.19.238';
const GAME_ID = process.env.GH_GAME_ID || '06817cbb13e4ce23';
const DIR = path.resolve(import.meta.dirname, '..', 'assets', 'achievements');

const token = process.argv[2] || process.env.GH_TOKEN;
if (!token) {
  console.error('用法：node tools/upload-icons.mjs <token>');
  process.exit(2);
}
const auth = { Authorization: 'Bearer ' + token };

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.png'));
let ok = 0;
const failed = [];

for (const file of files) {
  const m = /^(.+)-(unlock|locked)\.png$/.exec(file);
  if (!m) continue;
  const [, achId, slot] = m;
  const form = new FormData();
  form.append('slot', slot);
  form.append('file', new Blob([fs.readFileSync(path.join(DIR, file))], { type: 'image/png' }), file);
  const res = await fetch(`${HOST}/api/v1/projects/${GAME_ID}/achievements/${achId}/icon`, {
    method: 'POST', headers: auth, body: form
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    ok++;
  } else {
    failed.push(`${file}: ${res.status} ${body.error || ''}`);
  }
}

console.log(`上传成功 ${ok}/${files.length}`);
for (const f of failed) console.log('  ! ' + f);

// 复核：线上每个成就都该有两张图
const schema = (await (await fetch(`${HOST}/api/v1/projects/${GAME_ID}/progression`, { headers: auth })).json()).schema;
const missing = (schema.achievements || []).filter((a) => !a.icon_unlock || !a.icon_locked);
if (missing.length) {
  console.log('缺图标的成就：' + missing.map((a) => a.id).join(', '));
  process.exit(1);
}
console.log(`线上 ${schema.achievements.length} 个成就图标齐了`);
