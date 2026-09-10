/**
 * 生成成就图标（像素风，和游戏本体同一套调色）。
 *
 *   node tools/make-icons.mjs            # 写到 assets/achievements/
 *
 * 每个成就是一张 16×16 的手写点阵，放大 8 倍成 128×128 PNG；再按同一张点阵
 * 出一版去色压暗的 locked 图。不依赖任何第三方库，PNG 自己编码。
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const OUT = path.resolve(import.meta.dirname, '..', 'assets', 'achievements');
const SCALE = 8;

/** 点阵用的调色板。'.' = 透明 */
const PAL = {
  '.': null,
  k: [26, 18, 38],      // 描边深紫
  w: [255, 247, 232],   // 米白
  r: [214, 60, 74],     // 红
  o: [232, 162, 12],    // 金
  y: [246, 224, 94],    // 亮黄
  g: [93, 138, 53],     // 僵尸绿
  G: [142, 230, 111],   // 亮绿
  b: [58, 86, 128],     // 蓝
  p: [138, 109, 158],   // 紫
  m: [156, 35, 80],     // 洋红
  n: [120, 78, 46]      // 棕
};

/**
 * 16 行 × 16 列。这些图案是照着游戏里的水果 / 僵尸 / 卡牌画的，
 * 手写比程序生成好认，成就图标本来就该一眼能分辨。
 */
const ART = {
  // 挂带奖牌 + 一颗星：初次上路
  first_blood: [
    '..kk........kk..',
    '.kmmk......kmmk.',
    '.kmmmk....kmmmk.',
    '..kmmmk..kmmmk..',
    '...kmmmkkmmmk...',
    '....kmmmmmmk....',
    '.....kkkkkk.....',
    '...kkkkkkkkkk...',
    '..kooooooooook..',
    '.kooooykooooook.',
    '.kooookyykooook.',
    '.kooyyyyyyyyook.',
    '.kooookyykooook.',
    '..kooooykoooook.',
    '...kkkkkkkkkk...',
    '................'
  ],
  // 一串水果：水果忙人
  fruit_ninja: [
    '................',
    '.....kk.....kk..',
    '....kggk...kggk.',
    '...kkkkkk.kkkkk.',
    '..krrrrrrk......',
    '.krrrwrrrrk.....',
    '.krrrrrrrrk.....',
    '..krrrrrrk..kk..',
    '...kkkkkk..koyk.',
    '.......kkkkkkkk.',
    '......koooooook.',
    '.....kooyooooook',
    '.....kooooooook.',
    '......koooooook.',
    '.......kkkkkkk..',
    '................'
  ],
  // 两颗小果 → 一颗大果：合成学徒
  merge_apprentice: [
    '..kkkk....kkkk..',
    '.krrrrk..kggggk.',
    'krrwrrk..kgGgggk',
    'krrrrrk..kgggggk',
    '.krrrrk..kggggk.',
    '..kkkk....kkkk..',
    '.......kk.......',
    '.....kkkkkk.....',
    '......kkkk......',
    '.......kk.......',
    '....kkkkkkkk....',
    '...kooooooook...',
    '..koooyoooooook.',
    '..kooooooooooook',
    '...kooooooook...',
    '....kkkkkkkk....'
  ],
  // 大西瓜：大西瓜之王
  watermelon_king: [
    '.....k....k.....',
    '....kok..kok....',
    '...kokokokoko...',
    '...koooooooook..',
    '....kkkkkkkkk...',
    '...kkkkkkkkkk...',
    '..kgGgGgGgGgGk..',
    '.kgGrrrrrrrrGgk.',
    'kgGrrkrrrkrrrGgk',
    'kgGrrrrkrrrrrGgk',
    'kgGrrkrrrrkrrGgk',
    'kgGrrrrrkrrrrGgk',
    '.kgGrrrrrrrrGgk.',
    '..kgGgGgGgGgGk..',
    '...kkkkkkkkkk...',
    '................'
  ],
  // 僵尸头：僵尸猎人
  zombie_hunter: [
    '................',
    '....kkkkkkkk....',
    '...kgggggggggk..',
    '..kgGgggggggggk.',
    '..kgggggggggggk.',
    '..kgkwkgggkwkgk.',
    '..kgkkkgggkkkgk.',
    '..kgggggggggggk.',
    '..kggkgggggkggk.',
    '..kgggkkkkkgggk.',
    '..kgkwkwkwkwkgk.',
    '..kgggggggggggk.',
    '...kgggggggggk..',
    '....kkkkkkkkk...',
    '................',
    '................'
  ],
  // 骷髅：尸潮终结者
  zombie_slayer: [
    '................',
    '....kkkkkkkk....',
    '...kwwwwwwwwk...',
    '..kwwwwwwwwwwk..',
    '..kwwwwwwwwwwk..',
    '..kwkkwwwwkkwk..',
    '..kwkkwwwwkkwk..',
    '..kwwwwkkwwwwk..',
    '..kwwwwkkwwwwk..',
    '...kwwwwwwwwk...',
    '....kwkwkwkwk...',
    '....kwkwkwkwk...',
    '.....kkkkkkk....',
    '..kk..kk..kk....',
    '..rrkkrrkkrrk...',
    '................'
  ],
  // 六边形卡牌：海克斯收藏家
  card_collector: [
    '................',
    '.......kk.......',
    '.....kkppkk.....',
    '...kkppppppkk...',
    '..kppppppppppk..',
    '..kpppkyykpppk..',
    '..kppkyyyykppk..',
    '..kpkyyyyyykpk..',
    '..kpkyyyyyykpk..',
    '..kppkyyyykppk..',
    '..kpppkyykpppk..',
    '..kppppppppppk..',
    '...kkppppppkk...',
    '.....kkppkk.....',
    '.......kk.......',
    '................'
  ],
  // 数字牌 10K：万分选手
  score_10k: [
    '................',
    '.kkkkkkkkkkkkkk.',
    'kooooooooooooook',
    'koykkoykoyoykook',
    'kookoookookkoook',
    'kookoookookooook',
    'kookoookookkoook',
    'koykkoykoyoykook',
    'kooooooooooooook',
    'kokkkkkkkkkkkkok',
    'kokoyooooooyokok',
    'kokooooooooookok',
    'kokkkkkkkkkkkkok',
    'kooooooooooooook',
    '.kkkkkkkkkkkkkk.',
    '................'
  ],
  // 盾牌上的波浪：尸潮老兵
  wave_veteran: [
    '................',
    '.kkkkkkkkkkkkkk.',
    'kbbbbbbbbbbbbbbk',
    'kbbggbbbbbbggbbk',
    'kbggGggbbbggGggk',
    'kbggGgggbgggGggk',
    'kbbggbbgggbbggbk',
    'kbbbbbbbbbbbbbbk',
    'kbwwbwwbwwbwwbbk',
    'kbbbbbbbbbbbbbbk',
    '.kbbbbbbbbbbbbk.',
    '..kbbbbbbbbbbk..',
    '...kbbbbbbbbk...',
    '.....kbbbbk.....',
    '.......kk.......',
    '................'
  ],
  // 旗帜/终点：天路尽头
  the_end_of_road: [
    '................',
    '..kk............',
    '..kwk...........',
    '..kwkkkkkkkkk...',
    '..kwkwwkkwwkkk..',
    '..kwkkkwwkkwwk..',
    '..kwkwwkkwwkkk..',
    '..kwkkkwwkkwwk..',
    '..kwkkkkkkkkkk..',
    '..kwk...........',
    '..kwk...........',
    '..kwk...........',
    '..kwk...........',
    '.kkwkk..........',
    'kkkkkkk.........',
    '................'
  ],
  // 皇冠：联机冠军
  team_champion: [
    '................',
    '................',
    '..k..........k..',
    '.kok...kkk..kok.',
    '.kok..koyok.kok.',
    '.kok..koook.kok.',
    '.kok...kkk..kok.',
    '.kokk...k..kkok.',
    '.koookk.k.kkook.',
    '.kooooookoooook.',
    '.kooyoooooooook.',
    '.kooooooooyoook.',
    '.kkkkkkkkkkkkkk.',
    '.kmmmmmmmmmmmmk.',
    '.kkkkkkkkkkkkkk.',
    '................'
  ],
  // 砖墙：铜墙铁壁（隐藏）
  flawless_stage: [
    '................',
    '.kkkkkkkkkkkkkk.',
    'knnnnkknnnnnkknk',
    'knnnnkknnnnnkknk',
    'kkkkkkkkkkkkkkkk',
    'knnkknnnnnkknnnk',
    'knnkknnnnnkknnnk',
    'kkkkkkkkkkkkkkkk',
    'knnnnkknnnnnkknk',
    'knnnnkknnnnnkknk',
    'kkkkkkkkkkkkkkkk',
    'knnkknnnnnkknnnk',
    'knnkknnnnnkknnnk',
    'kkkkkkkkkkkkkkkk',
    '.kkkkkkkkkkkkkk.',
    '................'
  ]
};

// ---------------- PNG 编码（RGBA，无第三方库） ----------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(tag, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number[][]} px [y][x] = [r,g,b,a] */
function encodePng(px) {
  const h = px.length;
  const w = px[0].length;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px[y][x];
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 点阵 → 像素数组。
 * @param {boolean} locked true 时去色压暗，做未解锁的灰版
 */
function render(rows, locked) {
  const n = rows.length;
  const out = [];
  for (let y = 0; y < n * SCALE; y++) {
    const line = [];
    for (let x = 0; x < n * SCALE; x++) {
      const ch = rows[(y / SCALE) | 0][(x / SCALE) | 0];
      const col = PAL[ch];
      if (!col) {
        line.push([0, 0, 0, 0]);
        continue;
      }
      if (!locked) {
        line.push([col[0], col[1], col[2], 255]);
        continue;
      }
      // 灰版：取亮度后压到 30%~55%，保留描边的形状但整体发暗
      const lum = Math.round(0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2]);
      const v = Math.round(30 + (lum / 255) * 55);
      line.push([v, v, v + 6, 255]);
    }
    out.push(line);
  }
  return out;
}

/** 点阵是手写的，宽窄和错别字都靠这里挡住 */
function validate(id, rows) {
  const bad = [];
  if (rows.length !== 16) bad.push(`行数 ${rows.length}`);
  rows.forEach((r, i) => {
    if (r.length !== 16) bad.push(`第 ${i} 行 ${r.length} 列`);
    for (const ch of r) if (!(ch in PAL)) bad.push(`第 ${i} 行有未定义色号 '${ch}'`);
  });
  if (bad.length) throw new Error(`${id}: ${bad.join('；')}`);
}

fs.mkdirSync(OUT, { recursive: true });
let count = 0;
for (const [id, rows] of Object.entries(ART)) {
  validate(id, rows);
  for (const [suffix, locked] of [['unlock', false], ['locked', true]]) {
    const file = path.join(OUT, `${id}-${suffix}.png`);
    fs.writeFileSync(file, encodePng(render(rows, locked)));
    count++;
  }
}
console.log(`生成 ${count} 张图标 → ${OUT}`);
