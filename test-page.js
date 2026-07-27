/* =====================================================================
 * เปิดหน้าเว็บจริงด้วย jsdom แล้วดูว่ามีข้อผิดพลาดตอนโหลดหรือไม่
 *
 * จับบั๊กที่เทสต์แบบอ่านข้อความจับไม่ได้:
 *   - สคริปต์พังตอนโหลด ทำให้ปุ่มไม่ถูกผูกและข้อความไม่ถูกเติม
 *   - ข้อความไม่ถูกแปล (ช่องว่างเปล่า หรือโชว์ชื่อคีย์ดิบ เช่น dir.take)
 *   - สลับภาษาแล้วยังมีคำค้าง
 *
 * รัน:  node test-page.js
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')));
};

const ROOT = __dirname;
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** เปิดหน้าเว็บหนึ่งหน้าแล้วคืน window พร้อมรายการข้อผิดพลาดที่เกิดขึ้น */
async function openPage(file, { query = '', preScript = '' } = {}) {
  let html = read(path.join('public', file));

  // แทนสคริปต์ภายนอกด้วยไฟล์จริงในเครื่อง (จำลองว่าเซิร์ฟเวอร์เสิร์ฟให้ถูกต้อง)
  html = html.replace('<script src="/i18n.js"></script>', `<script>${read('i18n.js')}</script>`);
  html = html.replace('<script src="/go-engine.js"></script>', `<script>${read('go-engine.js')}</script>`);
  // ไม่ต้องโหลด Supabase จาก CDN ในเทสต์
  html = html.replace(/<script src="https:\/\/cdn[^"]*"><\/script>/g, '');
  // สคริปต์เตรียมสภาพแวดล้อม ใส่ก่อนสคริปต์ของหน้า
  const boot = `
    window.matchMedia = window.matchMedia || (q => ({ matches:false, media:q,
      addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }));
    ${preScript}
  `;
  html = html.replace('<script>', `<script>${boot}</script><script>`);

  const errors = [];
  // jsdom ไม่มี canvas จริง จึงข้ามข้อผิดพลาดกลุ่มนี้ ไม่ใช่บั๊กของเรา
  const ignorable = m => /getContext|Not implemented/.test(String(m));
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const msg = e.message + (e.detail ? ' | ' + e.detail : '');
    if (!ignorable(msg)) errors.push(msg);
  });
  vc.on('error', (...a) => { const m = a.join(' '); if (!ignorable(m)) errors.push(m); });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/' + (query ? '?' + query : ''),
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;

  // สิ่งที่ jsdom ไม่มีให้ ต้องใส่เอง
  w.WebSocket = class { constructor(){ this.readyState = 0; } send(){} close(){} };
  w.fetch = async () => ({ ok:true, json: async () => ({ assets: [] }), arrayBuffer: async () => new ArrayBuffer(8) });
  w.AudioContext = class {
    constructor(){ this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createGain(){ return { gain:{ value:1, setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; }
    createOscillator(){ return { frequency:{ value:0 }, type:'', connect(){}, start(){}, stop(){} }; }
    createBufferSource(){ return { buffer:null, loop:false, connect(){}, start(){}, stop(){} }; }
    decodeAudioData(){ return Promise.resolve({}); }
    resume(){}
  };
  w.speechSynthesis = { speaking:false, pending:false, getVoices:()=>[], speak(){}, cancel(){}, addEventListener(){} };
  w.SpeechSynthesisUtterance = class { constructor(t){ this.text = t; } };
  w.navigator.clipboard = { writeText: async () => {} };

  await new Promise(r => setTimeout(r, 120));
  return { w, errors, dom };
}

/** ข้อความที่ผู้ใช้มองเห็นทั้งหน้า */
function visibleText(w) {
  return [...w.document.querySelectorAll('[data-i18n]')].map(e => e.textContent.trim());
}

/* =====================================================================
 * index.html
 * ===================================================================== */
(async () => {
  console.log('\n[index.html]');
  const { w, errors } = await openPage('index.html', { preScript: "localStorage.setItem('gb_lang','th');" });
  ok('เปิดหน้าได้โดยไม่มีข้อผิดพลาด', errors.length === 0, errors.slice(0, 2).join(' || '));

  const texts = visibleText(w);
  ok('มีองค์ประกอบที่ต้องแปลอยู่จริง', texts.length > 10, 'พบ ' + texts.length);
  ok('ไม่มีข้อความว่างเปล่า', texts.every(t => t.length > 0),
     'ว่าง ' + texts.filter(t => !t).length + ' จุด');
  ok('ไม่มีชื่อคีย์ดิบโผล่บนหน้าจอ',
     !texts.some(t => /^[a-z]+\.[a-zA-Z]+$/.test(t)),
     texts.filter(t => /^[a-z]+\.[a-zA-Z]+$/.test(t)).slice(0, 3).join(', '));

  const login = w.document.querySelector('[data-i18n="auth.login"]').textContent;
  ok('เริ่มต้นเป็นภาษาไทย', login === 'เข้าสู่ระบบ', login);
  const aiOptions = [...w.document.getElementById('selAI').options];
  ok('ตัวเลือกระดับ AI ในหน้าผู้เล่นมีครบ 19 ระดับ',
     aiOptions.length === 19 && aiOptions[0].value === 'firstSteps' &&
     aiOptions.at(-1).value === 'worldPro', 'พบ ' + aiOptions.length + ' ระดับ');
  ok('ระดับสูงสุดแสดงโปรระดับโลก 9 ดั้งในภาษาไทย',
     aiOptions.at(-1).textContent.includes('โปรระดับโลก') &&
     aiOptions.at(-1).textContent.includes('โปร 9 ดั้ง'), aiOptions.at(-1).textContent);

  // สลับภาษา
  w.document.getElementById('btnLang').click();
  const en = w.document.querySelector('[data-i18n="auth.login"]').textContent;
  ok('กดปุ่มแล้วเปลี่ยนเป็นอังกฤษ', en === 'Log in', en);
  ok('ตัวเลือก World Pro เปลี่ยนเป็นอังกฤษตามหน้า',
     [...w.document.getElementById('selAI').options].at(-1).textContent.includes('World Pro'));
  ok('สลับภาษาแล้วไม่มีคำไทยค้าง',
     !visibleText(w).some(t => /[\u0E00-\u0E7F]/.test(t)),
     visibleText(w).filter(t => /[\u0E00-\u0E7F]/.test(t)).slice(0, 3).join(', '));

  w.document.getElementById('btnLang').click();
  const ja = w.document.querySelector('[data-i18n="auth.login"]').textContent;
  ok('กดอีกครั้งเปลี่ยนเป็นญี่ปุ่น', ja === 'ログイン', ja);
  ok('ปุ่มภาษาแสดงภาษาปัจจุบัน', w.document.getElementById('btnLang').textContent === 'JA');
  ok('ตัวเลือกโปรโลกเปลี่ยนเป็นญี่ปุ่นตามหน้า',
     [...w.document.getElementById('selAI').options].at(-1).textContent.includes('世界トッププロ'));

  ok('ช่องกรอกมีข้อความแนะนำ',
     !!w.document.getElementById('liUser').placeholder,
     w.document.getElementById('liUser').placeholder);

  /* ---- จำลองว่าโหลด i18n.js ไม่สำเร็จ — หน้าต้องยังใช้งานได้ ---- */
  console.log('\n[index.html — กรณีโหลดพจนานุกรมไม่สำเร็จ]');
  const broken = await openPage('index.html', { preScript: "delete window.I18N;" });
  const b = broken.w;
  ok('ยังเปิดหน้าได้ ไม่ตายเงียบ', broken.errors.length === 0, broken.errors[0] || '');
  ok('ปุ่มยังถูกผูกเหตุการณ์', typeof b.document.getElementById('btnGuest').onclick === 'function');

  /* =====================================================================
   * director.html
   * ===================================================================== */
  console.log('\n[director.html]');
  const d = await openPage('director.html');
  ok('เปิดหน้าได้โดยไม่มีข้อผิดพลาด', d.errors.length === 0, d.errors.slice(0, 2).join(' || '));
  const dt = visibleText(d.w);
  ok('ไม่มีข้อความว่างเปล่า', dt.every(t => t.length > 0), 'ว่าง ' + dt.filter(t => !t).length + ' จุด');
  ok('ไม่มีชื่อคีย์ดิบโผล่บนหน้าจอ',
     !dt.some(t => /^[a-z]+\.[a-zA-Z]+$/.test(t)),
     dt.filter(t => /^[a-z]+\.[a-zA-Z]+$/.test(t)).slice(0, 4).join(', '));
  ok('ปุ่ม TAKE มีข้อความจริง',
     /TAKE/.test(d.w.document.getElementById('btnTake').textContent),
     d.w.document.getElementById('btnTake').textContent);
  ok('รายการค่ายกลถูกเติมให้แล้ว',
     d.w.document.getElementById('selPattern').options.length >= 8,
     String(d.w.document.getElementById('selPattern').options.length));

  /* =====================================================================
   * live.html
   * ===================================================================== */
  console.log('\n[live.html]');
  const l = await openPage('live.html', { query: 'auto=1' });
  ok('เปิดหน้าได้โดยไม่มีข้อผิดพลาด', l.errors.length === 0, l.errors.slice(0, 2).join(' || '));
  ok('ปุ่มเริ่มถ่ายทอดมีข้อความ',
     l.w.document.getElementById('btnBoot').textContent.trim().length > 0,
     l.w.document.getElementById('btnBoot').textContent);
  ok('จอรอมีข้อความบอกสถานะ',
     l.w.document.getElementById('idleBig').textContent.trim().length > 0,
     l.w.document.getElementById('idleBig').textContent);
  ok('กล่อง MC มีข้อความตั้งต้น',
     l.w.document.getElementById('mcText').textContent.trim().length > 0);

  const lj = await openPage('live.html', { query: 'lang=ja' });
  ok('เปิดเป็นภาษาญี่ปุ่นผ่าน ?lang=ja ได้',
     /[\u3040-\u30FF\u4E00-\u9FFF]/.test(lj.w.document.getElementById('bootTitle').textContent),
     lj.w.document.getElementById('bootTitle').textContent);

  console.log(`\n════════════════════════════════`);
  console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
  console.log(`════════════════════════════════`);
  process.exit(fail ? 1 : 0);
})();
