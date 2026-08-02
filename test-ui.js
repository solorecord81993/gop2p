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
const { T } = require('./i18n.js');

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
  ok('แสดงโลโก้ Go Live', html.includes('src="/logo.svg"'));
  if (file === 'live.html') {
    ok('จอรอการแข่งขันไม่กล่าวถึงหน้าผู้กำกับ',
       !T('live.waitBody', {}, 'th').includes('/director'));
    ok('มีระบบพูดออกเสียงข้อความ MC',
       script.includes('SpeechSynthesisUtterance') && script.includes('Speech.say'));
    ok('ปลดล็อกเสียงพูดตอนกดปุ่มเริ่ม', script.includes('Speech.unlock()'));
    const bootSpeech = script.indexOf('const speechReady = Speech.unlock()');
    const bootAudio = script.indexOf('const audioReady = Snd.unlock()');
    ok('ปลดล็อก speech ก่อน await เสียงระบบ เพื่อรักษา user gesture บน iPhone',
       bootSpeech >= 0 && bootAudio > bootSpeech && script.includes('speakMC(lastMCText || T(\'live.readyVoice\')'));
    ok('เก็บและพูดซ้ำ MC ล่าสุดหลังปลดล็อกเสียง',
       script.includes('let lastMCText =') && script.includes('lastMCText = String(m.text || \'\')'));
    ok('ปิด MC แล้วหยุดเสียงพูดและคืนเพลงได้',
       script.includes('mc_stop') && script.includes('Speech.stop()') &&
       script.includes('Snd.restoreBGM()'));
    ok('เสียง MC เข้า AudioContext เดียวกับเพลงผ่าน TTS proxy',
       script.includes('Snd.playVoice') && script.includes("fetch('/api/tts?") &&
       script.includes('Snd.stopVoice'));
    ok('ประโยค MC ไม่ตัดกันเองและเว้นช่วงก่อนประโยคถัดไป',
       script.includes('activeVoice') && script.includes('pendingVoice') &&
       script.includes('VOICE_GAP_MS = 900') && !/function speakMC\([\s\S]*?Snd\.stopVoice\(\)/.test(script));
    ok('คิว MC เลือก event ล่าสุดที่สำคัญกว่า idle',
       script.includes('VOICE_PRIORITY') && script.includes('queueLatestVoice') &&
       script.includes("kind || 'idle'"));
    ok('สลับกระดานแล้วหยุดเสียงและล้างคิวทันที',
       script.includes('stopMCVoice();') && script.includes('pendingVoice = null') &&
       script.includes('liveProgramEpoch') && script.includes('stopCustomCutscene()'));
    ok('ไม่รับคำพากย์จากกระดานเก่าหลังสลับ',
       script.includes('m.programEpoch') && script.includes('m.program !== program') &&
       script.includes('epochChanged'));
    ok('เพลงมีระบบ resume และกู้คืนเมื่อหน้า Live กลับมาแสดง',
       script.includes('Snd.resume()') && script.includes('Snd.ensureBGM()') &&
       script.includes('source.loop = true') && script.includes('voiceEndTimer'));
    ok('จอว่างมี QR ลิงก์ และคำเชิญของ MC',
       declared.has('joinQr') && declared.has('joinLink') && declared.has('idleMcText'));
    ok('มีการ์ดสรุปคะแนนจริงหลังเกมจบ',
       declared.has('resultCard') && declared.has('resultBlack') &&
       declared.has('resultWhite') && script.includes('showResult'));
    ok('หน้าไลฟ์ไม่ติดป้ายว่าเป็น AI ข้างชื่อผู้เล่น',
       !/p\.name\s*\+\s*\(p\.ai/.test(script));
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
    ok('สร้าง AI ปะทะ AI และเลือกระดับได้ทั้งสองฝั่ง',
       declared.has('aiBlackLevel') && declared.has('aiWhiteLevel') &&
       declared.has('btnStartAI') && script.includes('director_create_ai_game'));
    ok('มีปุ่ม X บังคับปิดเกม active',
       declared.has('btnCloseProgram') && declared.has('btnClosePreview') &&
       script.includes('director_close_room') && script.includes('tile-close'));
    ok('หน้าคอนโทรลติด tag AI แยกตามฝั่ง',
       script.includes('blackAI') && script.includes('whiteAI') && script.includes('ai-badge'));
    ok('หน้าคอนโทรลแยกสถานะ Neural / Thinking / Fallback ชัดเจน',
       declared.has('neuralState') && script.includes('aiNeuralTag') &&
       script.includes('aiThinkingTag') && script.includes('aiFallbackTag'));
    ok('อัปเดตสถานะโดยไม่ล้างและสร้าง grid ใหม่ทุกครั้ง',
       script.includes('tileRefs') && script.includes('replaceChildren') &&
       !script.includes("const g = $('grid'); g.innerHTML = ''"));
    ok('ไม่ส่งคำสั่ง watch ซ้ำทุกครั้งที่ poll',
       script.includes('watchedCodesKey') && script.includes('if (key === watchedCodesKey) return'));
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
    ok('หน้าผู้เล่นเลือกระดับ AI ได้หลายขั้นถึง Neural Superhuman',
       declared.has('selAI') && script.includes('DEFAULT_AI_LEVELS') &&
       script.includes("id:'firstSteps'") && script.includes("id:'worldPro'") &&
       script.includes("id:'neuralMax'") && script.includes("engine:'neural'"));
    ok('ระดับ neural ถูกปิดเมื่อ server ยังไม่ได้ตั้งค่า',
       declared.has('neuralState') && script.includes('level.available === false') &&
       script.includes('home.neuralUnavailable'));
    ok('ส่งเฉพาะรหัสระดับให้เซิร์ฟเวอร์เป็นผู้กำหนดความเก่ง',
       script.includes("aiLevel:$('selAI').value") &&
       !script.includes('strength:+strength') && !script.includes('gor:+gor'));
  }
}

console.log(`\n════════════════════════════════`);
console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
console.log(`════════════════════════════════`);
process.exit(fail ? 1 : 0);
