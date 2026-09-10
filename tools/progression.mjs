/**
 * 把 gamehub.progression.json 推到 GameHub 项目页（整份替换 Schema）。
 *
 *   node tools/progression.mjs put   [token]   # 上传本地 schema
 *   node tools/progression.mjs get   [token]   # 拉线上 schema
 *   node tools/progression.mjs diff  [token]   # 比对本地与线上
 *
 * Token 只从命令行或 GH_TOKEN 环境变量读，绝不写进游戏包。
 */
import fs from 'fs';
import path from 'path';

const HOST = process.env.GH_HOST || 'http://101.43.19.238';
const GAME_ID = process.env.GH_GAME_ID || '06817cbb13e4ce23';
const ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA = path.join(ROOT, 'gamehub.progression.json');

const cmd = process.argv[2] || 'diff';
const token = process.argv[3] || process.env.GH_TOKEN;
if (!token) {
  console.error('缺少 token：node tools/progression.mjs <get|put|diff> <token>');
  process.exit(2);
}

const api = `${HOST}/api/v1/projects/${GAME_ID}/progression`;
const auth = { Authorization: 'Bearer ' + token };

async function call(method, body) {
  const res = await fetch(api, {
    method,
    headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 800) };
  }
  return { status: res.status, json };
}

/** 只比对 id 集合，字段级差异交给人看完整 JSON */
function ids(schema, key) {
  return (schema[key] || []).map((x) => x.id);
}

function summarize(label, schema) {
  console.log(`${label}: 统计 ${ids(schema, 'stats').length} · 成就 ${ids(schema, 'achievements').length} · 排行榜 ${ids(schema, 'leaderboards').length} · 展示 ${ids(schema, 'displays').length}`);
}

if (cmd === 'get') {
  const r = await call('GET');
  console.log(r.status);
  console.log(JSON.stringify(r.json.schema ?? r.json, null, 2));
} else if (cmd === 'put') {
  const local = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  summarize('本地', local);
  // 图标是用 upload-icons.mjs 传上去的，URL 只存在线上那份 Schema 里。
  // PUT 是整份替换，直接推本地会把图标抹掉，所以先取回来合进去。
  const before = (await call('GET')).json.schema || {};
  const liveIcons = new Map(
    (before.achievements || []).map((a) => [a.id, { unlock: a.icon_unlock, locked: a.icon_locked }])
  );
  let kept = 0;
  for (const a of local.achievements || []) {
    const live = liveIcons.get(a.id);
    if (!live) continue;
    if (live.unlock && !a.icon_unlock) { a.icon_unlock = live.unlock; kept++; }
    if (live.locked && !a.icon_locked) { a.icon_locked = live.locked; kept++; }
  }
  if (kept) console.log(`保留线上已有的 ${kept} 个图标 URL`);
  const r = await call('PUT', local);
  console.log('PUT →', r.status);
  if (r.status !== 200) {
    console.log(JSON.stringify(r.json, null, 2));
    process.exit(1);
  }
  const after = (await call('GET')).json.schema || {};
  summarize('线上', after);
  // 逐类核对 id，缺失说明服务端静默丢了条目
  for (const key of ['stats', 'achievements', 'leaderboards', 'displays']) {
    const missing = ids(local, key).filter((id) => !ids(after, key).includes(id));
    if (missing.length) console.log(`  ! ${key} 未落库: ${missing.join(', ')}`);
  }
} else {
  const local = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  const remote = (await call('GET')).json.schema || {};
  summarize('本地', local);
  summarize('线上', remote);
  for (const key of ['stats', 'achievements', 'leaderboards', 'displays']) {
    const l = ids(local, key);
    const r = ids(remote, key);
    const onlyLocal = l.filter((id) => !r.includes(id));
    const onlyRemote = r.filter((id) => !l.includes(id));
    if (onlyLocal.length) console.log(`  ${key} 仅本地: ${onlyLocal.join(', ')}`);
    if (onlyRemote.length) console.log(`  ${key} 仅线上: ${onlyRemote.join(', ')}`);
  }
}
