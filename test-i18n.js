/* =====================================================================
 * ตรวจระบบสามภาษา — จับบั๊ก "สลับภาษาแล้วมีคำค้าง" ที่เคยเจอใน Math Battle
 * รัน:  node test-i18n.js
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const { DICT, LANGS, T, rankLabel } = require('./i18n.js');
const { CANNED } = require('./mc.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')));
};

console.log('\n[พจนานุกรม]');

// ---- 1. ทุกคีย์ต้องมีครบทั้งสามภาษา ----
const allKeys = new Set();
for (const L of LANGS) for (const k of Object.keys(DICT[L])) allKeys.add(k);
const missing = [];
for (const L of LANGS) for (const k of allKeys) if (DICT[L][k] === undefined) missing.push(`${L}:${k}`);
ok(`ทุกคีย์มีครบทั้ง ${LANGS.length} ภาษา (${allKeys.size} คีย์)`, missing.length === 0, missing.slice(0, 8).join(', '));

// ---- 2. ห้ามมีค่าว่าง ----
const empty = [];
for (const L of LANGS) for (const [k, v] of Object.entries(DICT[L])) if (!String(v).trim()) empty.push(`${L}:${k}`);
ok('ไม่มีคำแปลที่เป็นค่าว่าง', empty.length === 0, empty.join(', '));

// ---- 3. ตัวแปรใน {} ต้องตรงกันทุกภาษา ----
const varMismatch = [];
for (const k of allKeys) {
  const sets = LANGS.map(L => new Set([...String(DICT[L][k] || '').matchAll(/\{(\w+)\}/g)].map(m => m[1])));
  const base = [...sets[0]].sort().join(',');
  for (let i = 1; i < sets.length; i++) {
    if ([...sets[i]].sort().join(',') !== base) { varMismatch.push(k); break; }
  }
}
ok('ตัวแปรใน {} ตรงกันทุกภาษา', varMismatch.length === 0, varMismatch.join(', '));

// ---- 4. ห้ามมีตัวอักษรของภาษาอื่นปน ----
const AI_NAMES = ['ai.seed15k', 'ai.bamboo10k', 'ai.ping8k'];
const AI_LEVEL_IDS = [
  'firstSteps', 'novice', 'starter', 'beginner', 'developing', 'foundation',
  'club', 'intermediate', 'strongKyu', 'advanced', 'expert', 'master',
  'grandmaster', 'amateurElite', 'amateurChampion', 'proEntry', 'pro',
  'elitePro', 'worldPro', 'neuralMax',
];
const strays = [];
for (const L of LANGS) {
  for (const [k, v] of Object.entries(DICT[L])) {
    if (L !== 'th' && /[\u0E00-\u0E7F]/.test(v) && !AI_NAMES.includes(k)) strays.push(`${L}:${k} มีอักษรไทย`);
    if (/[\u0400-\u04FF\uAC00-\uD7AF]/.test(v)) strays.push(`${L}:${k} มีอักษรแปลกปลอม`);
    if (L === 'en' && /[\u3040-\u30FF]/.test(v)) strays.push(`${L}:${k} มีอักษรญี่ปุ่น`);
  }
}
ok('ไม่มีตัวอักษรของภาษาอื่นปนอยู่', strays.length === 0, strays.slice(0, 6).join(', '));

// ---- 5. คำพากย์สำรองของ MC ต้องมีครบทั้งสามภาษาและทุกหมวด ----
const KINDS = ['idle', 'move', 'capture', 'start', 'byoyomi', 'end', 'cut'];
const mcMissing = [];
for (const L of LANGS) {
  for (const kind of KINDS) {
    const arr = CANNED[L] && CANNED[L][kind];
    if (!Array.isArray(arr) || arr.length === 0) mcMissing.push(`${L}.${kind}`);
  }
}
ok('คำพากย์สำรองของ MC ครบทุกภาษาและทุกหมวด', mcMissing.length === 0, mcMissing.join(', '));
ok('คำพากย์ตอนเงียบมีให้เลือกอย่างน้อย 4 แบบต่อภาษา',
   LANGS.every(L => CANNED[L].idle.length >= 4));

// ---- 6. ฟังก์ชันแปลทำงานถูกต้อง ----
ok('แทนค่าตัวแปรได้', T('rank.kyu', { n: 7 }, 'th') === '7 คิว', T('rank.kyu', { n: 7 }, 'th'));
ok('ไม่มีคีย์ในภาษานั้นจะถอยไปใช้ไทย', T('app.title', null, 'xx') === 'Go Battle Live');
ok('คีย์ที่ไม่มีจริงคืนชื่อคีย์กลับมา', T('ไม่มีคีย์นี้', null, 'th') === 'ไม่มีคีย์นี้');
ok('แปลง GoR เป็นระดับได้ทุกภาษา',
   rankLabel(2100, 'th') === '1 ดั้ง' && rankLabel(2100, 'en') === '1 dan' && rankLabel(2100, 'ja') === '1段',
   [rankLabel(2100, 'th'), rankLabel(2100, 'en'), rankLabel(2100, 'ja')].join(' / '));
ok('ชื่อระดับ AI ครบ 20 ขั้นในทุกภาษา',
   LANGS.every(L => AI_LEVEL_IDS.every(id => T('ai.level.' + id, null, L) !== 'ai.level.' + id)));
ok('ป้ายระดับโปรแปลครบทุกภาษา',
   T('rank.pro', { n:9 }, 'th') === 'โปร 9 ดั้ง' &&
   T('rank.pro', { n:9 }, 'en') === '9 pro dan' &&
   T('rank.pro', { n:9 }, 'ja') === 'プロ9段');

/* =====================================================================
 * ตรวจหน้าเว็บว่าไม่มีข้อความตายตัวหลงเหลือ
 * ===================================================================== */
for (const file of ['index.html', 'director.html', 'live.html']) {
  console.log(`\n[${file}]`);
  const html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  const script = (html.match(/<script>\n([\s\S]*?)\n<\/script>/) || [])[1] || '';
  const markup = html.slice(html.indexOf('<body>'), html.lastIndexOf('<script>'));

  // ตัดคอมเมนต์ทุกแบบออกก่อนตรวจ (ทั้งบล็อกและท้ายบรรทัด)
  const codeOnly = script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => {
      // ตัด // ที่อยู่นอกเครื่องหมายคำพูด
      let q = null, out = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { out += c; if (c === q && line[i-1] !== '\\') q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
        if (c === '/' && line[i+1] === '/') break;
        out += c;
      }
      return out;
    })
    .join('\n');

  // ชื่อภาษาต้องเขียนด้วยภาษาของตัวเองเสมอ จึงยกเว้นให้
  const ALLOW = ['ไทย'];

  // ข้อความไทยในมาร์กอัป (ยกเว้นคอมเมนต์ HTML และชื่อภาษา)
  let markupNoComment = markup.replace(/<!--[\s\S]*?-->/g, '');
  for (const a of ALLOW) markupNoComment = markupNoComment.split(a).join('');
  const thaiInMarkup = (markupNoComment.match(/[\u0E00-\u0E7F]+/g) || []);
  ok('ไม่มีข้อความไทยตายตัวในมาร์กอัป', thaiInMarkup.length === 0, thaiInMarkup.slice(0, 5).join(' | '));

  // ข้อความไทยในโค้ด — อนุญาตเฉพาะ console และตัวแปรที่รู้จัก
  const thaiLines = codeOnly.split('\n')
    .map(l => { let s = l; for (const a of ALLOW) s = s.split(a).join(''); return s; })
    .filter(l => /[\u0E00-\u0E7F]/.test(l) && !/console\.(warn|error|info|log)/.test(l));
  ok('ไม่มีข้อความไทยตายตัวในโค้ดที่ผู้ใช้มองเห็น', thaiLines.length === 0,
     thaiLines.slice(0, 3).map(s => s.trim().slice(0, 60)).join(' | '));

  // ต้องมีกลไกเปลี่ยนภาษา
  ok('มีฟังก์ชันเติมข้อความตามภาษา', codeOnly.includes('function applyLang'));
}

console.log(`\n════════════════════════════════`);
console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
console.log(`════════════════════════════════`);
process.exit(fail ? 1 : 0);
