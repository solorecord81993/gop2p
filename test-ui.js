/* =====================================================================
 * ตรวจหน้าเว็บโดยไม่ต้องเปิดเบราว์เซอร์
 *
 * จับบั๊กประเภทที่เคยทำให้ "กดอะไรก็ไม่ไป" โดยเฉพาะ:
 *   - อ้างถึง id ที่ไม่มีอยู่จริงในหน้า  ->  $() คืน null -> TypeError -> ทั้งหน้าตาย
 *   - โค้ดระดับบนสุดที่พังได้ถ้าสคริปต์ภายนอกโหลดไม่สำเร็จ
 *   - ปุ่มที่ไม่มีตัวจัดการเหตุการณ์
 * รัน:  node test-ui.js
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')));
};

const PAGES = ['index.html', 'director.html', 'live.html'];

for (const file of PAGES) {
  const html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  const script = (html.match(/<script>\n([\s\S]*?)\n<\/script>/) || [])[1] || '';
  console.log(`\n[${file}]`);

  // ---- 1. id ที่อ้างถึงต้องมีอยู่จริง ----
  const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
  // id ที่สร้างขึ้นเองด้วย JavaScript
  for (const m of script.matchAll(/\.id\s*=\s*'([^']+)'/g)) declared.add(m[1]);
  const missing = [...used].filter(id => !declared.has(id));
  ok('ทุก id ที่อ้างถึงมีอยู่จริงในหน้า', missing.length === 0, missing.join(', '));

  // ---- 2. ปุ่มทุกตัวต้องมีคนรับเหตุการณ์ ----
  const buttons = [...html.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  // ผูกตรง ๆ หรือเก็บไว้ในตัวแปร/อาเรย์แล้วผูกทีหลัง ก็นับว่าใช้ได้
  const unbound = buttons.filter(id => !script.includes(`'${id}'`));
  ok('ปุ่มทุกตัวมีตัวจัดการเหตุการณ์', unbound.length === 0, unbound.join(', '));

  // ---- 3. ไม่มีการแตกตัวแปรจากสคริปต์ภายนอกที่ระดับบนสุด ----
  //      (ถ้า CDN โหลดไม่ทัน จะทำให้ทั้งหน้าตายเงียบ)
  const risky = script.match(/^const\s*\{[^}]+\}\s*=\s*window\.\w+;/m);
  ok('ไม่มีโค้ดระดับบนสุดที่พังได้ถ้าสคริปต์ภายนอกโหลดไม่สำเร็จ', !risky, risky ? risky[0] : '');

  // ---- 4. ต้องมีตัวดักข้อผิดพลาดเพื่อไม่ให้ตายเงียบ ----
  if (file === 'index.html') {
    ok('มีตัวดักข้อผิดพลาดแล้วแสดงบนหน้าจอ',
       script.includes("addEventListener('error'") && script.includes('function fatal'));
    ok('มีตัวบอกสถานะการเชื่อมต่อให้ผู้ใช้เห็น', script.includes('paintNet'));
  }

  // ---- 5. ตั้งค่า Supabase เรียบร้อย ----
  if (file === 'index.html') {
    const url = (script.match(/SUPABASE_URL:\s*'([^']+)'/) || [])[1] || '';
    const key = (script.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1] || '';
    ok('ใส่ Project URL แล้ว และไม่มีเครื่องหมาย / ปิดท้าย',
       /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url), url);
    let payload = null;
    try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString()); } catch {}
    ok('คีย์เป็น anon และตรงกับโปรเจกต์เดียวกับ URL',
       !!payload && payload.role === 'anon' && url.includes(payload.ref),
       payload ? payload.role + '/' + payload.ref : 'อ่านคีย์ไม่ได้');
    ok('คีย์ยังไม่หมดอายุ', !!payload && payload.exp * 1000 > Date.now());
  }

  // ---- 5b. ต้องโหลดพจนานุกรมสามภาษา ----
  ok('โหลด /i18n.js', html.includes('/i18n.js'));
  ok('โหลดธีมสว่างและ responsive ร่วมกัน',
     html.includes('/ui-light.css') && /name="viewport"/.test(html));
  if (file === 'live.html') {
    ok('มีระบบพูดออกเสียงข้อความ MC',
       script.includes('SpeechSynthesisUtterance') && script.includes('Speech.say'));
    ok('ปลดล็อกเสียงพูดตอนกดปุ่มเริ่ม', script.includes('Speech.unlock()'));
    const reset = (script.match(/function resetLiveView\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
    ok('program null ล้างสถานะของ live view',
       script.includes('if (!program) resetLiveView()') &&
       ['view = null', 'clockBase = null', 'localGame = null', 'bgmNow = null']
         .every(statement => reset.includes(statement)));
    ok('program null หยุด BGM และคืนข้อความรอถ่ายทอด',
       reset.includes('Snd.stopBGM()') &&
       reset.includes("$('roomTag').textContent = '——'") &&
       reset.includes("$('mcText').textContent = T('mc.waiting')"));
  }

  // ---- 5c. หน้าตั้งค่าของผู้กำกับ ----
  if (file === 'director.html') {
    ok('มีหน้าตั้งค่าและปุ่มเปิด', html.includes('id="settings"') && html.includes('id="btnSettings"'));
    ok('มีช่องใส่คีย์ Groq และ OpenRouter', html.includes('id="inGroq"') && html.includes('id="inOR"'));
    ok('คีย์ถูกปิดบังตอนพิมพ์', /id="inGroq"[^>]*type="password"/.test(html));
    ok('ส่งรหัสผู้กำกับไปกับทุกคำขอ', script.includes('x-director-token'));
    ok('อัปโหลดไฟล์เสียงได้ และจำกัดชนิดไฟล์', script.includes("accept=") && script.includes('/api/audio/'));
    ok('เลือกภาษาหน้าจอและภาษา MC แยกกันได้',
       declared.has('uiLang') && declared.has('mcLang') &&
       script.includes("$('uiLang').onchange") && script.includes("$('mcLang').onchange"));
  }

  // ---- 5d. หน้าเว็บต้องโหลดไฟล์เสียงที่อัปโหลดไว้ ----
  if (file === 'index.html' || file === 'live.html') {
    ok('โหลดรายการไฟล์เสียงและเตรียมล่วงหน้า', script.includes('applyManifest'));
    ok('สลับเพลงตามสถานะเกม และเพลงต้องวน', script.includes('updateBGM') && script.includes('loop = true'));
  }

  // ---- 6. สมัครสมาชิกด้วยชื่อผู้ใช้ ไม่ต้องใช้อีเมล ----
  if (file === 'index.html') {
    ok('หน้าสมัครไม่มีช่องอีเมล', !/type="email"/.test(html));
    ok('มีช่องชื่อผู้ใช้ทั้งหน้าเข้าสู่ระบบและหน้าสมัคร',
       declared.has('liUser') && declared.has('suUser'));
    ok('แปลงชื่อผู้ใช้เป็นอีเมลภายในให้อัตโนมัติ',
       script.includes('USER_DOMAIN') && script.includes('toEmail'));
  }
}

console.log(`\n════════════════════════════════`);
console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
console.log(`════════════════════════════════`);
process.exit(fail ? 1 : 0);
