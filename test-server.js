/* =====================================================================
 * ทดสอบเซิร์ฟเวอร์แบบครบวงจร — เปิดเซิร์ฟเวอร์จริง ต่อ WebSocket จริง
 * รัน:  node test-server.js
 * ===================================================================== */
process.env.AI_DELAY_MS   = process.env.AI_DELAY_MS   ?? '0';    // ทดสอบให้เร็ว ไม่ต้องหน่วง
process.env.AUTO_DWELL_MS = process.env.AUTO_DWELL_MS ?? '600';  // ย่นเวลาค้างห้องตอนทดสอบ
const WebSocket = require('ws');
const { server, consume, remainingMs, newClock, gorToLabel } = require('./server.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => {
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- ตัวช่วยฝั่งไคลเอนต์ ---- */
class Client {
  constructor(port, name) {
    this.name = name; this.inbox = []; this.state = null;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ready = new Promise(res => this.ws.on('open', res));
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      this.inbox.push(m);
      if (m.t === 'state' || m.t === 'end') this.state = m;
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  // รอข้อความชนิดที่ต้องการ
  wait(type, timeout = 3000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const i = this.inbox.findIndex(m => m.t === type);
        if (i >= 0) { clearInterval(iv); res(this.inbox.splice(i, 1)[0]); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('หมดเวลารอ ' + type)); }
      }, 10);
    });
  }
  waitState(pred, timeout = 5000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.state && pred(this.state)) { clearInterval(iv); res(this.state); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error('หมดเวลารอสถานะ')); }
      }, 10);
    });
  }
  close() { this.ws.close(); }
}

/* =====================================================================
 * ทดสอบหน่วยย่อย: นาฬิกา
 * ===================================================================== */
function testClock() {
  console.log('\n[1] นาฬิกา (เวลาหลัก + เบียวโยมิ)');

  let c = newClock({ main: 10, byoyomi: 30, periods: 3 });
  ok('หักเวลาหลักปกติ', consume(c, 4000) === false && c.mainMs === 6000);

  c = newClock({ main: 10, byoyomi: 30, periods: 3 });
  consume(c, 12000);
  ok('เวลาหลักหมด → เข้าเบียวโยมิ ไม่ตาย', c.inByoyomi === true && c.periods === 3);

  c = newClock({ main: 0, byoyomi: 30, periods: 3 });
  ok('เดินทันในรอบเบียวโยมิ → รอบรีเซ็ต ไม่เสียรอบ',
     consume(c, 25000) === false && c.periods === 3 && c.periodMs === 30000);

  c = newClock({ main: 0, byoyomi: 30, periods: 3 });
  consume(c, 35000);
  ok('เกินหนึ่งรอบ → เสียรอบไปหนึ่ง', c.periods === 2);

  c = newClock({ main: 0, byoyomi: 30, periods: 1 });
  ok('รอบสุดท้ายหมด → หมดเวลา', consume(c, 35000) === true);

  c = newClock({ main: 5, byoyomi: 0, periods: 0 });
  ok('ไม่มีเบียวโยมิ → เวลาหลักหมดคือหมดเวลาทันที', consume(c, 6000) === true);

  ok('แปลง GoR เป็นป้ายดั้งถูกต้อง',
     gorToLabel(2100) === '1 ดั้ง' && gorToLabel(2000) === '1 คิว' && gorToLabel(100) === '20 คิว',
     `${gorToLabel(2100)} / ${gorToLabel(2000)} / ${gorToLabel(100)}`);
}

/* =====================================================================
 * ทดสอบครบวงจรผ่าน WebSocket
 * ===================================================================== */
async function testFlow(port) {
  console.log('\n[2] เล่นสองคนจนจบเกมและนับแต้ม');

  const A = new Client(port, 'ดำ'), B = new Client(port, 'ขาว');
  await Promise.all([A.ready, B.ready]);

  A.send({ t: 'auth', name: 'ผู้เล่นดำ' });
  B.send({ t: 'auth', name: 'ผู้เล่นขาว' });
  const wa = await A.wait('welcome'); await B.wait('welcome');
  ok('ยืนยันตัวตนแบบผู้มาเยือนได้', wa.guest === true && !!wa.playerToken);

  A.send({ t: 'create', size: 9, timeRule: { main: 300, byoyomi: 30, periods: 3 } });
  const ja = await A.wait('joined');
  ok('สร้างห้องได้รหัส 6 หลัก', ja.code.length === 6 && ja.color === 'B');

  B.send({ t: 'join', code: ja.code });
  const jb = await B.wait('joined');
  ok('อีกฝ่ายเข้าห้องแล้วได้ที่นั่งขาว', jb.color === 'W');

  const st = await A.waitState(s => s.players.white);
  ok('โคมิของ 9×9 = 1.5 ตามสมาคมฯ', st.game.komi === 1.5, 'ได้ ' + st.game.komi);

  // ยังไม่กดพร้อม ต้องเดินไม่ได้
  A.send({ t: 'play', x: 2, y: 2 });
  const e1 = await A.wait('error');
  ok('ยังไม่กดพร้อม เดินไม่ได้', e1.msg.includes('ยังไม่เริ่ม'));

  A.send({ t: 'ready', value: true });
  B.send({ t: 'ready', value: true });
  await A.waitState(s => s.state === 'playing');
  ok('ทั้งคู่พร้อม → เกมเริ่มอัตโนมัติ', true);

  // ดำเดินก่อน
  B.send({ t: 'play', x: 4, y: 4 });
  const e2 = await B.wait('error');
  ok('เดินผิดตาไม่ได้', e2.msg.includes('ยังไม่ถึงตา'));

  A.send({ t: 'play', x: 2, y: 2 });
  await A.waitState(s => s.game.moveCount === 1);
  ok('ดำวางหมากได้', A.state.game.board[2 * 9 + 2] === 1);

  B.send({ t: 'play', x: 2, y: 2 });
  const e3 = await B.wait('error');
  ok('วางทับหมากเดิมไม่ได้', e3.msg.includes('มีหมากอยู่แล้ว'));

  // มุมซ้ายบน: ขาววาง (0,0) แล้วดำจับกิน
  B.send({ t: 'play', x: 0, y: 0 });
  await B.waitState(s => s.game.moveCount === 2);
  A.send({ t: 'play', x: 1, y: 0 });
  await A.waitState(s => s.game.moveCount === 3);
  B.send({ t: 'play', x: 8, y: 8 });
  await B.waitState(s => s.game.moveCount === 4);
  A.send({ t: 'play', x: 0, y: 1 });
  const capState = await A.waitState(s => s.game.moveCount === 5);
  ok('จับกินได้ และนับเชลยให้ดำ',
     capState.game.board[0] === 0 && capState.game.prisoners.black === 1);

  // นาฬิกาเดินจริง
  ok('นาฬิกาเดินและเซิร์ฟเวอร์เป็นคนคุม', capState.clocks.black.main < 300000);

  // ผ่านสองครั้ง → เข้าเฟสตกลงหมากตาย
  B.send({ t: 'pass' });
  await B.waitState(s => s.game.moveCount === 6);
  A.send({ t: 'pass' });
  const mk = await A.waitState(s => s.state === 'marking');
  ok('ผ่านสองครั้ง → เข้าเฟสตกลงหมากตาย และนาฬิกาหยุด', mk.state === 'marking');

  // ต้องยืนยันทั้งสองฝ่าย
  A.send({ t: 'confirm_score' });
  await A.waitState(s => s.confirms.black === true);
  ok('ยืนยันฝ่ายเดียวยังไม่จบเกม', A.state.state === 'marking');

  B.send({ t: 'confirm_score' });
  const end = await A.wait('end', 3000);
  ok('ยืนยันครบสองฝ่าย → จบเกมและนับแต้ม', !!end.result.text, end.result.text);
  ok('ผลนับแบบญี่ปุ่น มีพื้นที่+เชลย+โคมิ',
     end.score && end.score.komi === 1.5 && 'territory' in end.score && 'dameCount' in end.score);

  A.close(); B.close();
}

/* =====================================================================
 * ทดสอบ: ไม่ตกลงกัน กลับไปเล่นต่อ
 * ===================================================================== */
async function testResume(port) {
  console.log('\n[3] ตกลงหมากตายไม่ได้ → กลับไปเล่นต่อ');
  const A = new Client(port), B = new Client(port);
  await Promise.all([A.ready, B.ready]);
  A.send({ t: 'auth', name: 'ก' }); B.send({ t: 'auth', name: 'ข' });
  await A.wait('welcome'); await B.wait('welcome');
  A.send({ t: 'create', size: 9, timeRule: { main: 300, byoyomi: 30, periods: 3 } });
  const j = await A.wait('joined');
  B.send({ t: 'join', code: j.code }); await B.wait('joined');
  A.send({ t: 'ready' }); B.send({ t: 'ready' });
  await A.waitState(s => s.state === 'playing');

  A.send({ t: 'play', x: 4, y: 4 }); await A.waitState(s => s.game.moveCount === 1);
  B.send({ t: 'pass' }); await B.waitState(s => s.game.moveCount === 2);
  A.send({ t: 'pass' }); await A.waitState(s => s.state === 'marking');

  B.send({ t: 'resume_play' });
  const back = await A.waitState(s => s.state === 'playing');
  ok('กลับไปเล่นต่อได้ และตัวนับผ่านถูกล้าง', back.state === 'playing');

  B.send({ t: 'play', x: 3, y: 3 });
  const after = await B.waitState(s => s.game.board[3 * 9 + 3] === 2);
  ok('เล่นต่อจากตำแหน่งเดิมได้ หมากเดิมยังอยู่', after.game.board[4 * 9 + 4] === 1);
  ok('ตัวนับผ่านถูกล้าง (ผ่านครั้งเดียวไม่จบเกม)', after.state === 'playing');
  A.close(); B.close();
}

/* =====================================================================
 * ทดสอบ: เล่นกับ AI
 * ===================================================================== */
async function testAI(port) {
  console.log('\n[4] เล่นกับคอมพิวเตอร์');
  const A = new Client(port);
  await A.ready;
  A.send({ t: 'auth', name: 'ผู้ท้าชิง' }); await A.wait('welcome');
  A.send({ t: 'create', size: 9, timeRule: { main: 300, byoyomi: 30, periods: 3 },
           vsAI: true, ai: { id: 'seed15k', name: 'น้องเมล็ด', strength: 0.3, gor: 600 } });
  await A.wait('joined');
  const s0 = await A.waitState(s => !!s.players.white);
  ok('AI นั่งที่นั่งขาวและพร้อมอัตโนมัติ', s0.players.white.ai === true && s0.ready.white === true);

  A.send({ t: 'ready' });
  await A.waitState(s => s.state === 'playing');
  A.send({ t: 'play', x: 4, y: 4 });
  const s1 = await A.waitState(s => s.game.moveCount >= 2, 8000);
  ok('AI เดินตอบภายในเวลาที่กำหนด', s1.game.moveCount >= 2);
  ok('ตาของ AI ถูกกติกา', s1.game.board.filter(v => v === 2).length === 1);

  // ให้ AI เล่นต่ออีกหลายตา ดูว่าไม่พังและไม่เดินผิดกติกา
  let moves = s1.game.moveCount;
  for (let i = 0; i < 6; i++) {
    const legal = [];
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++)
      if (A.state.game.board[y * 9 + x] === 0) legal.push([x, y]);
    const [x, y] = legal[Math.floor(Math.random() * legal.length)];
    A.send({ t: 'play', x, y });
    try { await A.waitState(s => s.game.moveCount > moves + 1, 8000); moves = A.state.game.moveCount; }
    catch { break; }
  }
  ok('เล่นกับ AI ต่อเนื่องหลายตาโดยไม่ล่ม', A.state.game.moveCount >= 6, 'ตาที่ ' + A.state.game.moveCount);
  A.close();
}

/* =====================================================================
 * ทดสอบ: หลุดแล้วกลับเข้าที่นั่งเดิม
 * ===================================================================== */
async function testReconnect(port) {
  console.log('\n[5] หลุดแล้วกลับเข้าที่นั่งเดิม');
  const A = new Client(port), B = new Client(port);
  await Promise.all([A.ready, B.ready]);
  A.send({ t: 'auth', name: 'ก' }); B.send({ t: 'auth', name: 'ข' });
  const wa = await A.wait('welcome'); await B.wait('welcome');
  A.send({ t: 'create', size: 9, timeRule: { main: 300, byoyomi: 30, periods: 3 } });
  const j = await A.wait('joined');
  B.send({ t: 'join', code: j.code }); await B.wait('joined');
  A.send({ t: 'ready' }); B.send({ t: 'ready' });
  await A.waitState(s => s.state === 'playing');
  A.send({ t: 'play', x: 2, y: 2 }); await A.waitState(s => s.game.moveCount === 1);

  A.close();
  await sleep(300);

  const A2 = new Client(port);
  await A2.ready;
  A2.send({ t: 'auth', name: 'ก', playerToken: wa.playerToken });
  await A2.wait('welcome');
  A2.send({ t: 'join', code: j.code });
  const re = await A2.wait('joined');
  ok('กลับเข้าที่นั่งเดิมได้ ไม่กลายเป็นผู้ชม', re.reconnected === true && re.color === 'B');
  const s = await A2.waitState(s => s.game.moveCount === 1);
  ok('สถานะกระดานยังอยู่ครบหลังกลับเข้ามา', s.game.board[2 * 9 + 2] === 1);
  A2.close(); B.close();
}

/* =====================================================================
 * ทดสอบ: หมดเวลา
 * ===================================================================== */
async function testTimeout(port) {
  console.log('\n[6] หมดเวลาแล้วปรับแพ้อัตโนมัติ');
  const A = new Client(port), B = new Client(port);
  await Promise.all([A.ready, B.ready]);
  A.send({ t: 'auth', name: 'ก' }); B.send({ t: 'auth', name: 'ข' });
  await A.wait('welcome'); await B.wait('welcome');
  A.send({ t: 'create', size: 9, timeRule: { main: 1, byoyomi: 0, periods: 0 } });
  const j = await A.wait('joined');
  B.send({ t: 'join', code: j.code }); await B.wait('joined');
  A.send({ t: 'ready' }); B.send({ t: 'ready' });
  await A.waitState(s => s.state === 'playing');

  const end = await A.wait('end', 5000);
  ok('ดำหมดเวลา → ขาวชนะด้วย W+T', end.result.text === 'W+T' && end.result.reason === 'หมดเวลา',
     JSON.stringify(end.result));
  A.close(); B.close();
}

/* =====================================================================
 * ทดสอบ: หน้าเบื้องหลัง
 * ===================================================================== */
async function testDirector(port) {
  console.log('\n[7] หน้าเบื้องหลังและรายชื่อห้อง');
  const A = new Client(port), D = new Client(port);
  await Promise.all([A.ready, D.ready]);
  A.send({ t: 'auth', name: 'ก' }); await A.wait('welcome');
  A.send({ t: 'create', size: 9, timeRule: { main: 300, byoyomi: 30, periods: 3 } });
  const j = await A.wait('joined');

  D.send({ t: 'auth', name: 'ผู้กำกับ' }); await D.wait('welcome');
  D.send({ t: 'director_auth', token: 'ผิดแน่นอน' });
  const err = await D.wait('error');
  ok('รหัสผู้กำกับผิด เข้าไม่ได้', err.msg.includes('ไม่ถูกต้อง'));

  D.send({ t: 'director_auth', token: 'dev-director' });
  await D.wait('director_ok');
  D.send({ t: 'program', code: j.code });
  const pg = await D.wait('program');
  ok('ผู้กำกับสั่งห้องขึ้นออกอากาศได้', pg.code === j.code);

  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`).then(r => r.json());
  const found = res.rooms.find(r => r.code === j.code);
  ok('API รายชื่อห้องคืนค่าครบ', !!found && found.onAir === true && typeof found.heat === 'number');
  A.close(); D.close();
}


/* =====================================================================
 * ทดสอบ: กติกาพิเศษผ่านเซิร์ฟเวอร์ (โคะ / ฆ่าตัวตาย / ผู้ชม / อีโมจิ / ยอมแพ้)
 * ===================================================================== */
async function testRules(port) {
  console.log('\n[8] กติกาพิเศษ ผู้ชม และอีโมจิ');
  const A = new Client(port), B = new Client(port), S = new Client(port);
  await Promise.all([A.ready, B.ready, S.ready]);
  A.send({ t: 'auth', name: 'ก' }); B.send({ t: 'auth', name: 'ข' }); S.send({ t: 'auth', name: 'คนดู' });
  await A.wait('welcome'); await B.wait('welcome'); await S.wait('welcome');
  A.send({ t: 'create', size: 9, timeRule: { main: 600, byoyomi: 30, periods: 3 } });
  const j = await A.wait('joined');
  B.send({ t: 'join', code: j.code }); await B.wait('joined');

  S.send({ t: 'join', code: j.code });
  const sj = await S.wait('joined');
  ok('คนที่สามเข้าห้องเต็มกลายเป็นผู้ชม', sj.spectator === true && sj.color === null);
  S.send({ t: 'play', x: 0, y: 0 });
  const se = await S.wait('error');
  ok('ผู้ชมเดินหมากไม่ได้', se.msg.includes('ผู้ชม'));

  A.send({ t: 'ready' }); B.send({ t: 'ready' });
  await A.waitState(s => s.state === 'playing');

  // สร้างรูปโคะมาตรฐาน
  //      x: 0 1 2 3
  //  y=0:   . B W .
  //  y=1:   B W . W        <- ดำวาง (2,1) กินขาว (1,1) หนึ่งเม็ด = เกิดโคะ
  //  y=2:   . B W .
  const seq = [
    ['A',1,0], ['B',2,0], ['A',0,1], ['B',2,2],
    ['A',1,2], ['B',3,1], ['A',7,7], ['B',1,1],
  ];
  let n = 0;
  for (const [who, x, y] of seq) {
    (who === 'A' ? A : B).send({ t:'play', x, y });
    n++; await A.waitState(s => s.game.moveCount === n);
  }
  A.send({ t:'play', x:2, y:1 }); n++;
  const koState = await A.waitState(s => s.game.moveCount === n);
  ok('ดำกินขาวหนึ่งเม็ดแล้วเกิดโคะ',
     koState.game.prisoners.black === 1 && koState.game.koPoint === 1*9+1,
     'เชลย=' + koState.game.prisoners.black + ' koPoint=' + koState.game.koPoint);
  B.send({ t:'play', x:1, y:1 });
  const koErr = await B.wait('error');
  ok('ขาวกินคืนทันทีไม่ได้ (ติดโคะ)', koErr.msg.includes('โคะ'), koErr.msg);

  // ฆ่าตัวตาย: ขาวไปเล่นที่อื่นก่อนหนึ่งตา แล้วดำ... ทดสอบตรง ๆ ที่มุม
  B.send({ t:'play', x:0, y:8 }); n++; await B.waitState(s => s.game.moveCount === n);
  A.send({ t:'play', x:0, y:0 }); n++; await A.waitState(s => s.game.moveCount === n);
  // ตอนนี้ (0,0) ดำ, (1,0) ดำ, (0,1) ดำ -> ขาวลง (0,0) ไม่ได้อยู่แล้ว (มีหมาก)
  // สร้างจุดฆ่าตัวตายจริงที่มุมขวาบน
  B.send({ t:'play', x:8, y:1 }); n++; await B.waitState(s => s.game.moveCount === n);
  A.send({ t:'play', x:6, y:6 }); n++; await A.waitState(s => s.game.moveCount === n);
  B.send({ t:'play', x:7, y:0 }); n++; await B.waitState(s => s.game.moveCount === n);
  A.send({ t:'play', x:5, y:5 }); n++; await A.waitState(s => s.game.moveCount === n);
  // ขาวล้อม (8,0) ไว้แล้วด้วย (7,0) และ (8,1) -> ดำลง (8,0) = ฆ่าตัวตาย
  B.send({ t:'play', x:4, y:0 }); n++; await B.waitState(s => s.game.moveCount === n);
  A.send({ t:'play', x:8, y:0 });
  const sui = await A.wait('error');
  ok('ห้ามวางฆ่าตัวตาย', sui.msg.includes('ฆ่าตัวตาย'), sui.msg);

  // อีโมจิต้องถึงทุกคนรวมผู้ชม
  A.send({ t:'emoji', id:'clap' });
  const em = await S.wait('emoji');
  ok('อีโมจิกระจายถึงผู้ชมด้วย (ไม่ใช่แค่โฮสต์)', em.id === 'clap');

  // ยอมแพ้
  B.send({ t:'resign' });
  const end = await S.wait('end');
  ok('ยอมแพ้แล้วจบเกมทันที และผู้ชมเห็นผลด้วย', end.result.text === 'B+R' && end.result.reason === 'ยอมแพ้');
  A.close(); B.close(); S.close();
}

/* =====================================================================
 * ทดสอบ: เล่นกับ AI จนจบเกมจริงและนับแต้มได้
 * ===================================================================== */
async function testAIFullGame(port) {
  console.log('\n[9] เล่นกับ AI จนจบเกมและนับแต้ม');
  const A = new Client(port);
  await A.ready;
  A.send({ t: 'auth', name: 'ผู้ท้าชิง' }); await A.wait('welcome');
  A.send({ t: 'create', size: 9, timeRule: { main: 600, byoyomi: 30, periods: 3 },
           vsAI: true, ai: { id:'seed15k', name:'น้องเมล็ด', strength:0.3, gor:600 } });
  await A.wait('joined');
  await A.waitState(s => !!s.players.white);
  A.send({ t:'ready' });
  await A.waitState(s => s.state === 'playing');

  // ผู้เล่นเดินสุ่มไปเรื่อย ๆ จนกระดานเต็ม แล้วปิดเกมด้วยการผ่าน
  const deadline = Date.now() + 60_000;
  while (A.state.state === 'playing' && Date.now() < deadline) {
    try { await A.waitState(s => s.game.turn === 1 || s.state !== 'playing', 8000); }
    catch { break; }
    if (A.state.state !== 'playing') break;

    const b = A.state.game.board, legal = [];
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (b[y*9+x] === 0) legal.push([x, y]);
    const before = A.state.game.moveCount;

    if (legal.length <= 4) { A.send({ t:'pass' }); }
    else {
      const [x, y] = legal[Math.floor(Math.random()*legal.length)];
      A.send({ t:'play', x, y });
    }
    try { await A.waitState(s => s.game.moveCount > before || s.state !== 'playing', 2500); }
    catch { A.send({ t:'pass' }); await sleep(600); }   // ตาที่ผิดกติกา -> ผ่านแทน
  }

  ok('เล่นกับ AI ได้ยาวโดยเซิร์ฟเวอร์ไม่ล่ม', A.state.game.moveCount > 20, 'ตาที่ ' + A.state.game.moveCount);

  if (A.state.state === 'marking') {
    A.send({ t:'confirm_score' });
    const end = await A.wait('end', 4000);
    ok('AI ยืนยันนับแต้มให้อัตโนมัติ → จบเกมได้', !!end.result.text, end.result.text);
    ok('แต้มรวมสมเหตุสมผล', end.score && (end.score.black + end.score.white) > 0);
  } else {
    ok('เกมจบด้วยสถานะที่ถูกต้อง', A.state.state === 'finished', A.state.state);
  }
  A.close();
}


/* =====================================================================
 * ทดสอบ: ผู้กำกับดูหลายห้องพร้อมกันโดยไม่แย่งที่นั่ง + ไฟล์หน้าเว็บ
 * ===================================================================== */
async function testWatchAndFiles(port) {
  console.log('\n[10] ผู้กำกับเฝ้าหลายห้อง และไฟล์หน้าเว็บ');
  const A = new Client(port), B = new Client(port), D = new Client(port);
  await Promise.all([A.ready, B.ready, D.ready]);
  A.send({ t:'auth', name:'ก' }); B.send({ t:'auth', name:'ข' }); D.send({ t:'auth', name:'ผู้กำกับ' });
  await A.wait('welcome'); await B.wait('welcome'); await D.wait('welcome');

  A.send({ t:'create', size:9, timeRule:{ main:300, byoyomi:30, periods:3 } });
  const j1 = await A.wait('joined');
  B.send({ t:'create', size:13, timeRule:{ main:300, byoyomi:30, periods:3 } });
  const j2 = await B.wait('joined');

  D.send({ t:'director_auth', token:'dev-director' });
  await D.wait('director_ok');
  D.send({ t:'watch', codes:[j1.code, j2.code] });
  const s1 = await D.wait('state');
  const s2 = await D.wait('state');
  ok('ผู้กำกับรับสถานะได้พร้อมกันหลายห้อง',
     [s1.code, s2.code].sort().join() === [j1.code, j2.code].sort().join());

  // ห้องแรกยังมีที่นั่งขาวว่าง — ผู้กำกับต้องไม่ไปนั่งแทน
  const still = [s1, s2].find(s => s.code === j1.code);
  ok('ผู้กำกับไม่แย่งที่นั่งผู้เล่น', still.players.white === null || still.players.white === undefined);

  // ผู้กำกับได้รับความเคลื่อนไหวของห้องที่เฝ้าอยู่
  D.inbox.length = 0;
  A.send({ t:'ready' });
  const upd = await D.wait('state', 3000);
  ok('ผู้กำกับเห็นความเคลื่อนไหวของห้องที่เฝ้าอยู่', upd.code === j1.code);

  // เข้าชมอย่างเดียว แม้ที่นั่งจะว่าง
  const S = new Client(port); await S.ready;
  S.send({ t:'auth', name:'คนดู' }); await S.wait('welcome');
  S.send({ t:'spectate', code:j1.code });
  const sj = await S.wait('joined');
  ok('คำสั่ง spectate เข้าเป็นผู้ชมแม้ที่นั่งว่าง', sj.spectator === true && sj.color === null);

  // ไฟล์หน้าเว็บ
  for (const [path, must] of [['/', 'Go Battle Live'], ['/director.html', 'PROGRAM'], ['/go-engine.js', 'class GoGame']]) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await r.text();
    ok(`เสิร์ฟไฟล์ ${path} ได้`, r.status === 200 && body.includes(must));
  }
  const hz = await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.text());
  ok('มี /healthz สำหรับ Render ตรวจสุขภาพ', hz === 'ok');

  A.close(); B.close(); D.close(); S.close();
}


/* =====================================================================
 * ทดสอบ: หน้าภาพออกอากาศ (live.html)
 * ===================================================================== */
async function testLive(port) {
  console.log('\n[11] ภาพออกอากาศ — สลับห้อง คัตซีน และ MC');
  const A = new Client(port), B = new Client(port), D = new Client(port), L = new Client(port);
  await Promise.all([A.ready, B.ready, D.ready, L.ready]);
  for (const [c, n] of [[A,'ก'],[B,'ข'],[D,'ผู้กำกับ'],[L,'ภาพออกอากาศ']]) c.send({ t:'auth', name:n });
  await Promise.all([A.wait('welcome'), B.wait('welcome'), D.wait('welcome'), L.wait('welcome')]);

  A.send({ t:'create', size:9,  timeRule:{ main:300, byoyomi:30, periods:3 } });
  const r1 = await A.wait('joined');
  B.send({ t:'create', size:13, timeRule:{ main:300, byoyomi:30, periods:3 } });
  const r2 = await B.wait('joined');

  D.send({ t:'director_auth', token:'dev-director' });
  await D.wait('director_ok');
  D.send({ t:'program', code:null });          // ตัดเป็นจอดำก่อน
  await D.wait('program');

  L.send({ t:'live' });
  const p0 = await L.wait('program');
  ok('หน้าไลฟ์ต่อได้ และรู้ว่ายังไม่มีห้องออกอากาศ (จอดำ)', p0.code === null || p0.code === undefined);

  // ส่งห้องแรกขึ้นภาพ
  D.send({ t:'program', code:r1.code });
  const p1 = await L.wait('program');
  const s1 = await L.wait('state');
  ok('ผู้กำกับกด TAKE แล้วหน้าไลฟ์เปลี่ยนห้องตาม', p1.code === r1.code && s1.code === r1.code);
  ok('มีชนิดทรานซิชันแนบมาด้วย', typeof p1.transition === 'string', String(p1.transition));

  // ความเคลื่อนไหวของห้องที่ออกอากาศต้องถึงหน้าไลฟ์
  L.inbox.length = 0;
  A.send({ t:'ready' });
  const upd = await L.wait('state', 3000);
  ok('หน้าไลฟ์เห็นความเคลื่อนไหวของห้องที่ออกอากาศ', upd.code === r1.code);

  // ห้องที่ไม่ได้ออกอากาศต้องไม่หลุดมา
  L.inbox.length = 0;
  B.send({ t:'ready' });
  await sleep(400);
  ok('ห้องที่ไม่ได้ออกอากาศไม่หลุดขึ้นภาพ', !L.inbox.some(m => m.t === 'state' && m.code === r2.code));

  // สลับไปห้องที่สอง
  D.send({ t:'program', code:r2.code, transition:'fade' });
  const p2 = await L.wait('program');
  ok('สลับไปห้องที่สองได้ พร้อมทรานซิชันที่สั่ง', p2.code === r2.code && p2.transition === 'fade');

  // คัตซีนและ MC
  D.send({ t:'highlight', nameTh:'ค่ายกลย้อนศร', nameJa:'ウッテガエシ', tier:'SSR', coords:[[3,3]] });
  const hl = await L.wait('highlight');
  ok('ผู้กำกับยิงคัตซีนขึ้นภาพออกอากาศได้', hl.nameTh === 'ค่ายกลย้อนศร' && hl.tier === 'SSR');

  D.send({ t:'mc', text:'ตานี้ตัดสินเกมเลยครับ' });
  const mc = await L.wait('mc');
  ok('ส่งข้อความ MC ขึ้นภาพได้', mc.text === 'ตานี้ตัดสินเกมเลยครับ');

  // ผู้เล่นต้องไม่เห็นคัตซีน (เห็นเฉพาะบนไลฟ์)
  B.inbox.length = 0;
  D.send({ t:'highlight', nameTh:'แทงกลางตา', tier:'SSR' });
  await sleep(300);
  ok('ผู้เล่นไม่เห็นคัตซีน', !B.inbox.some(m => m.t === 'highlight'));

  // คนที่ไม่ใช่ผู้กำกับยิงคัตซีนไม่ได้
  A.send({ t:'highlight', nameTh:'โกง', tier:'SSR' });
  const e = await A.wait('error');
  ok('คนทั่วไปยิงคัตซีนไม่ได้', e.msg.includes('ไม่มีสิทธิ์'));

  const html = await fetch(`http://127.0.0.1:${port}/live`).then(r => r.text());
  ok('เสิร์ฟ /live ได้ และเป็นภาพแนวตั้ง 1080×1920',
     html.includes('1080px') && html.includes('1920px'));

  A.close(); B.close(); D.close(); L.close();
}


/* =====================================================================
 * ทดสอบ: โหมดถ่ายทอดด้วยมือถือเครื่องเดียว (สลับห้องอัตโนมัติ ไม่มีผู้กำกับ)
 * ===================================================================== */
async function testAutoBroadcast(port) {
  console.log('\n[12] ถ่ายทอดแบบอัตโนมัติ ไม่ต้องมีผู้กำกับ');
  const D = new Client(port); await D.ready;
  D.send({ t:'auth', name:'ผู้กำกับ' }); await D.wait('welcome');
  D.send({ t:'director_auth', token:'dev-director' }); await D.wait('director_ok');
  D.send({ t:'program', code:null }); await D.wait('program');   // เริ่มจากจอดำ

  const L = new Client(port); await L.ready;
  L.send({ t:'auth', name:'ภาพออกอากาศ' }); await L.wait('welcome');
  L.send({ t:'live', auto:true });
  const p0 = await L.wait('program');
  ok('เปิดโหมดอัตโนมัติจากหน้าออกอากาศได้', p0.auto === true);

  // ยังไม่มีห้อง -> จอว่าง
  ok('ยังไม่มีห้อง ภาพจึงว่างไว้ก่อน', !p0.code);

  // เปิดห้องแล้วเริ่มเล่น ระบบต้องยกขึ้นภาพให้เอง
  const A = new Client(port), B = new Client(port);
  await Promise.all([A.ready, B.ready]);
  A.send({ t:'auth', name:'ก' }); B.send({ t:'auth', name:'ข' });
  await A.wait('welcome'); await B.wait('welcome');
  A.send({ t:'create', size:9, timeRule:{ main:300, byoyomi:30, periods:3 } });
  const r = await A.wait('joined');

  const p1 = await L.wait('program', 4000);
  ok('มีคนเปิดห้อง ระบบยกขึ้นภาพให้อัตโนมัติ', p1.code === r.code);
  const s1 = await L.wait('state', 3000);
  ok('หน้าออกอากาศได้รับสถานะห้องนั้นด้วย', s1.code === r.code);

  // เสียงต้องถึงหน้าออกอากาศด้วย
  B.send({ t:'join', code:r.code }); await B.wait('joined');
  A.send({ t:'ready' }); B.send({ t:'ready' });
  await L.wait('state', 3000);
  L.inbox.length = 0;
  A.send({ t:'play', x:4, y:4 });
  const sfx = await L.wait('sfx', 3000);
  ok('เสียงวางหมากถึงหน้าออกอากาศ (ไม่ใช่แค่ฝั่งผู้เล่น)', sfx.id === 'stone');

  // ผู้กำกับเข้ามาคุมเอง = ปิดโหมดอัตโนมัติ
  D.send({ t:'program', code:r.code });
  await D.wait('program');
  D.send({ t:'auto', value:false });
  const a2 = await D.wait('auto');
  ok('ผู้กำกับปิดโหมดอัตโนมัติได้', a2.value === false);

  const html = await fetch(`http://127.0.0.1:${port}/live`).then(r => r.text());
  ok('หน้าออกอากาศเปิดเต็มจอบน iPhone ได้ (มี meta ของเว็บแอป)',
     html.includes('apple-mobile-web-app-capable'));
  ok('มีปุ่มแตะเพื่อเริ่ม สำหรับปลดล็อกเสียงและกันจอดับ',
     html.includes('btnBoot') && html.includes('wakeLock'));

  A.close(); B.close(); D.close(); L.close();
}

/* ===================================================================== */
(async () => {
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  console.log(`เซิร์ฟเวอร์ทดสอบทำงานที่พอร์ต ${port}`);

  testClock();
  try {
    await testAutoBroadcast(port);
    await testFlow(port);
    await testResume(port);
    await testAI(port);
    await testReconnect(port);
    await testTimeout(port);
    await testDirector(port);
    await testRules(port);
    await testAIFullGame(port);
    await testWatchAndFiles(port);
    await testLive(port);
  } catch (e) {
    fail++; console.log('  FAIL การทดสอบหยุดกลางคัน → ' + e.message);
  }

  console.log(`\n════════════════════════════════`);
  console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
  console.log(`════════════════════════════════`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
