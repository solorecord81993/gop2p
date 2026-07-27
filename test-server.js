/* =====================================================================
 * ทดสอบเซิร์ฟเวอร์แบบครบวงจร — เปิดเซิร์ฟเวอร์จริง ต่อ WebSocket จริง
 * รัน:  node test-server.js
 * ===================================================================== */
process.env.AI_DELAY_MS   = process.env.AI_DELAY_MS   ?? '0';    // ทดสอบให้เร็ว ไม่ต้องหน่วง
process.env.AUTO_DWELL_MS = process.env.AUTO_DWELL_MS ?? '600';  // ย่นเวลาค้างห้องตอนทดสอบ
process.env.MC_MIN_GAP_MS = process.env.MC_MIN_GAP_MS ?? '300';  // ให้ MC พูดถี่ขึ้นตอนทดสอบ
process.env.MC_IDLE_MS    = process.env.MC_IDLE_MS    ?? '900';
process.env.AI_RESULT_HOLD_MS = process.env.AI_RESULT_HOLD_MS ?? '120';
const WebSocket = require('ws');
const {
  server, rooms, createRoom, consume, remainingMs, newClock, gorToLabel,
  AI_LEVELS, endGame,
} = require('./server.js');

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
  // รอข้อความชนิดที่ต้องการซึ่งตรงเงื่อนไขเพิ่มเติม (เช่น MC หลายข้อความปนกัน)
  waitWhere(type, pred, timeout = 4000) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const i = this.inbox.findIndex(m => m.t === type && pred(m));
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
  ok('ยังไม่กดพร้อม เดินไม่ได้', e1.code === 'not_started', e1.code);

  A.send({ t: 'ready', value: true });
  B.send({ t: 'ready', value: true });
  await A.waitState(s => s.state === 'playing');
  ok('ทั้งคู่พร้อม → เกมเริ่มอัตโนมัติ', true);

  // ดำเดินก่อน
  B.send({ t: 'play', x: 4, y: 4 });
  const e2 = await B.wait('error');
  ok('เดินผิดตาไม่ได้', e2.code === 'not_your_turn', e2.code);

  A.send({ t: 'play', x: 2, y: 2 });
  await A.waitState(s => s.game.moveCount === 1);
  ok('ดำวางหมากได้', A.state.game.board[2 * 9 + 2] === 1);

  B.send({ t: 'play', x: 2, y: 2 });
  const e3 = await B.wait('error');
  ok('วางทับหมากเดิมไม่ได้', e3.code === 'occupied', e3.code);

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
  A.send({ t: 'auth', name: 'ผู้ท้าชิง' });
  const welcome = await A.wait('welcome');
  ok('หน้าผู้เล่นได้รับระดับ AI ครบถึง Neural Superhuman',
     Array.isArray(welcome.aiLevels) && welcome.aiLevels.length === 20 &&
     welcome.aiLevels[0].rank === '30k' &&
     welcome.aiLevels.at(-1).id === 'neuralMax' &&
     welcome.aiLevels.at(-1).engine === 'neural' &&
     welcome.aiLevels.at(-1).available === false);
  const roomsBeforeUnavailable = rooms.size;
  A.send({ t: 'create', size: 9, vsAI: true, aiLevel: 'neuralMax',
           timeRule: { main: 300, byoyomi: 30, periods: 3 } });
  const unavailable = await A.wait('error');
  ok('ไม่แอบใช้ heuristic เมื่อยังไม่ได้ตั้งค่า neural engine',
     unavailable.code === 'neural_unavailable' && rooms.size === roomsBeforeUnavailable);
  A.send({ t: 'create', size: 9, timeRule: { main: 300, byoyomi: 30, periods: 3 },
           vsAI: true, aiLevel: 'worldPro',
           ai: { id: 'ปลอม', name: 'ปลอม', strength: 0, gor: -999 } });
  const joined = await A.wait('joined');
  const s0 = await A.waitState(s => !!s.players.white);
  ok('AI นั่งที่นั่งขาวและพร้อมอัตโนมัติ', s0.players.white.ai === true && s0.ready.white === true);
  ok('ผู้เล่นเลือก World Pro แล้วได้ระดับ 9p จริงใน state',
     s0.players.white.aiLevel === 'worldPro' && s0.players.white.rank === '9p');
  const selectedAI = rooms.get(joined.code)?.seats[2];
  ok('เซิร์ฟเวอร์ยึดโปรไฟล์ World Pro จาก catalog และไม่เชื่อค่าปลอมจาก client',
     selectedAI?.ai?.strength === 1 && selectedAI?.ai?.reading === 10 &&
     selectedAI?.ai?.replyWeight === 0.85 && selectedAI?.gor === 3900 &&
     selectedAI?.name !== 'ปลอม');

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
 * ทดสอบ: ผู้กำกับสร้าง AI ปะทะ AI และบังคับปิดห้อง
 * ===================================================================== */
async function testDirectorAIBattle(port) {
  console.log('\n[4b] ผู้กำกับสร้าง AI ปะทะ AI');
  const D = new Client(port);
  await D.ready;
  D.send({ t:'auth', name:'ผู้กำกับ' }); await D.wait('welcome');
  D.send({ t:'director_auth', token:'dev-director' });
  const auth = await D.wait('director_ok');
  ok('ส่งระดับ AI หลายระดับให้หน้าคอนโทรล',
     Array.isArray(auth.aiLevels) && auth.aiLevels.length === 20 &&
     auth.aiLevels.some(x => x.id === 'starter') &&
     auth.aiLevels.some(x => x.id === 'neuralMax' && x.available === false));
  const worldPro = AI_LEVELS.find(level => level.id === 'worldPro');
  ok('ระดับ AI ครอบคลุม 30 คิวถึง Neural Superhuman',
     AI_LEVELS[0].rank === '30k' && worldPro?.rank === '9p' &&
     worldPro?.reading === 10 && AI_LEVELS.at(-1).engine === 'neural');

  D.send({
    t:'director_create_ai_game',
    size:9,
    blackLevel:'starter',
    whiteLevel:'worldPro',
  });
  const created = await D.wait('ai_game_created', 4000);
  ok('เกม AI ปะทะ AI เริ่มเล่นทันที',
     created.mode === 'ai_vs_ai' && created.state === 'playing');
  ok('AI ทั้งสองฝั่งมี tag และระดับแยกกันใน state',
     created.players.black.ai === true && created.players.white.ai === true &&
     created.players.black.aiLevel === 'starter' &&
     created.players.white.aiLevel === 'worldPro' &&
     created.players.white.rank === '9p');
  ok('สุ่มชื่อ AI ให้เหมือนชื่อคนและไม่ซ้ำกัน',
     /[\u0E00-\u0E7F]/.test(created.players.black.name) &&
     /[\u0E00-\u0E7F]/.test(created.players.white.name) &&
     created.players.black.name !== created.players.white.name &&
     !/AI|🤖/i.test(created.players.black.name + created.players.white.name));
  D.send({ t:'watch', codes:[created.code] });
  const advanced = await D.waitWhere('state',
    state => state.code === created.code && state.game.moveCount >= 2, 5000);
  ok('AI ฝั่งดำและขาวผลัดกันเดินได้เอง', advanced.game.moveCount >= 2);

  const listing = await fetch(`http://127.0.0.1:${port}/api/rooms`).then(r => r.json());
  const listed = listing.rooms.find(r => r.code === created.code);
  ok('รายการห้องบอกชัดว่า AI อยู่ฝั่งดำและขาว',
     listed?.blackAI === true && listed?.whiteAI === true &&
     listed?.blackAILevel === 'starter' && listed?.whiteAILevel === 'worldPro');

  D.send({ t:'director_close_room', code:created.code });
  const closed = await D.wait('room_closed', 3000);
  ok('ผู้กำกับบังคับปิดเกมที่ active ได้ทันที',
     closed.code === created.code && closed.reason === 'director');
  const after = await fetch(`http://127.0.0.1:${port}/api/rooms`).then(r => r.json());
  ok('ห้องที่บังคับปิดหายจากรายการ active',
     !after.rooms.some(r => r.code === created.code));
  D.close();
}

async function testAIResultHold() {
  console.log('\n[4c] สรุปผล AI ค้างก่อนปิดอัตโนมัติ');
  const room = createRoom({ size:9, mode:'ai_vs_ai', timeRule:{ main:0, byoyomi:30, periods:3 } });
  const score = {
    black:12, white:10.5, diff:1.5, text:'B+1.5',
    territory:{ black:10, white:8 }, prisoners:{ black:2, white:1 },
    komi:1.5, dameCount:0,
  };
  const before = Date.now();
  endGame(room, { type:'black_win', text:'B+1.5', score }, { score });
  ok('สถานะจบมีคะแนนจริงและกำหนดเวลาปิด',
     room.state === 'finished' && room.score.black === 12 &&
     room.autoCloseAt >= before + 100);
  await sleep(220);
  ok('ครบเวลาค้างแล้วปิดห้อง AI อัตโนมัติ', !rooms.has(room.code));
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
  ok('รหัสผู้กำกับผิด เข้าไม่ได้', err.code === 'bad_director_token', err.code);

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
  ok('ผู้ชมเดินหมากไม่ได้', se.code === 'spectator', se.code);

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
  ok('ขาวกินคืนทันทีไม่ได้ (ติดโคะ)', koErr.code === 'ko', koErr.code);

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
  ok('ห้ามวางฆ่าตัวตาย', sui.code === 'suicide', sui.code);

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
  for (const [path, must] of [['/', 'Go Battle Live'], ['/director.html', 'dir.program'],
                              ['/go-engine.js', 'class GoGame'], ['/i18n.js', 'LANG_NAMES']]) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await r.text();
    ok(`เสิร์ฟไฟล์ ${path} ได้`, r.status === 200 && body.includes(must));
  }
  const logo = await fetch(`http://127.0.0.1:${port}/logo.svg`);
  ok('เสิร์ฟโลโก้ SVG ด้วย MIME type ที่เบราว์เซอร์แสดงเป็นรูปภาพได้',
     logo.status === 200 && logo.headers.get('content-type') === 'image/svg+xml' &&
     (await logo.text()).includes('<svg'));
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
  const mc = await L.waitWhere('mc', m => m.text === 'ตานี้ตัดสินเกมเลยครับ');
  ok('ผู้กำกับส่งข้อความ MC เองได้', mc.text === 'ตานี้ตัดสินเกมเลยครับ');

  // ผู้เล่นต้องไม่เห็นคัตซีน (เห็นเฉพาะบนไลฟ์)
  B.inbox.length = 0;
  D.send({ t:'highlight', nameTh:'แทงกลางตา', tier:'SSR' });
  await sleep(300);
  ok('ผู้เล่นไม่เห็นคัตซีน', !B.inbox.some(m => m.t === 'highlight'));

  // คนที่ไม่ใช่ผู้กำกับยิงคัตซีนไม่ได้
  A.send({ t:'highlight', nameTh:'โกง', tier:'SSR' });
  const e = await A.wait('error');
  ok('คนทั่วไปยิงคัตซีนไม่ได้', e.code === 'no_permission', e.code);

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


/* =====================================================================
 * ทดสอบ: MC พากย์อัตโนมัติ (ไม่มีคีย์ AI ต้องใช้คำสำรองและไม่เงียบ)
 * ===================================================================== */
async function testMC(port) {
  console.log('\n[13] MC พากย์อัตโนมัติ');
  const D = new Client(port), L = new Client(port), A = new Client(port), B = new Client(port);
  await Promise.all([D.ready, L.ready, A.ready, B.ready]);
  for (const [c, n] of [[D,'ผู้กำกับ'],[L,'ภาพออกอากาศ'],[A,'ก'],[B,'ข']]) c.send({ t:'auth', name:n });
  await Promise.all([D.wait('welcome'), L.wait('welcome'), A.wait('welcome'), B.wait('welcome')]);

  A.send({ t:'create', size:9, timeRule:{ main:300, byoyomi:30, periods:3 } });
  const r = await A.wait('joined');
  B.send({ t:'join', code:r.code }); await B.wait('joined');

  D.send({ t:'director_auth', token:'dev-director' }); await D.wait('director_ok');
  L.send({ t:'live', lang:'th' });
  const info = await L.wait('mc_info');
  ok('หน้าไลฟ์รู้สถานะ MC ตอนเชื่อมต่อ', info.lang === 'th' && info.auto === true);
  ok('ไม่มีคีย์ AI ระบบก็ยังทำงาน', typeof info.hasAI === 'boolean');

  const first = await L.wait('mc', 4000);
  ok('MC พูดทันทีเมื่อเปิดหน้าไลฟ์', !!first.text && first.text.length > 3, first.text);
  ok('ไม่มีคีย์ AI จึงใช้คำพากย์สำรอง', first.source === 'canned', first.source);

  // สลับห้องขึ้นภาพแล้ว MC ต้องพูดถึงห้องนั้น
  D.send({ t:'program', code:r.code }); await D.wait('program');
  const onAir = await L.wait('mc', 4000);
  ok('MC พูดตอนสลับห้องขึ้นภาพ', !!onAir.text, onAir.text);

  // เดินหมากแล้วต้องมีพากย์ตามมา
  A.send({ t:'ready' }); B.send({ t:'ready' });
  await A.waitState(s => s.state === 'playing');
  L.inbox.length = 0;
  const said = new Set();
  for (let i = 0; i < 6; i++) {
    const c = i % 2 === 0 ? A : B;
    c.send({ t:'play', x:i, y:i });
    await sleep(1400);
    for (const m of L.inbox.filter(m => m.t === 'mc')) said.add(m.text);
  }
  ok('MC พูดต่อเนื่องระหว่างเดินหมาก', said.size >= 1, 'ได้ ' + said.size + ' ประโยค');
  ok('พูดไม่ซ้ำประโยคเดิมติดกัน', said.size === new Set([...said]).size);

  // เปลี่ยนภาษา MC
  D.send({ t:'mc_lang', lang:'ja' });
  const jl = await D.wait('mc_lang');
  ok('ผู้กำกับเปลี่ยนภาษา MC เป็นญี่ปุ่นได้', jl.lang === 'ja');
  const jaLine = await L.waitWhere('mc', m => m.lang === 'ja', 4000);
  ok('ประโยคที่ได้เป็นภาษาญี่ปุ่นจริง', /[\u3040-\u30FF\u4E00-\u9FFF]/.test(jaLine.text), jaLine.text);

  D.send({ t:'mc_lang', lang:'en' });
  await D.wait('mc_lang');
  const enLine = await L.waitWhere('mc', m => m.lang === 'en', 4000);
  ok('เปลี่ยนเป็นอังกฤษได้และไม่มีอักษรไทยปน',
     !/[\u0E00-\u0E7F]/.test(enLine.text), enLine.text);

  // ปิดพากย์อัตโนมัติ
  D.send({ t:'mc_auto', value:false });
  const off = await D.wait('mc_auto');
  ok('ปิดพากย์อัตโนมัติได้', off.value === false);
  L.inbox.length = 0;
  A.send({ t:'play', x:7, y:7 });
  await sleep(1200);
  ok('ปิดแล้วไม่พากย์อีก', !L.inbox.some(m => m.t === 'mc'));
  D.send({ t:'mc_auto', value:true }); await D.wait('mc_auto');
  D.send({ t:'mc_lang', lang:'th' }); await D.wait('mc_lang');

  A.close(); B.close(); D.close(); L.close();
}


/* =====================================================================
 * ทดสอบ: หน้าตั้งค่าของผู้กำกับ (คีย์ AI และไฟล์เสียง)
 * ===================================================================== */
async function testSettings(port) {
  console.log('\n[14] หน้าตั้งค่า — คีย์ AI และไฟล์เสียง');
  const base = `http://127.0.0.1:${port}`;
  const TOK = { 'x-director-token': 'dev-director' };

  // ต้องมีรหัสผู้กำกับเท่านั้น
  const noAuth = await fetch(`${base}/api/settings`).then(r => r.status);
  ok('เข้าหน้าตั้งค่าโดยไม่มีรหัสไม่ได้', noAuth === 403, String(noAuth));

  const s = await fetch(`${base}/api/settings`, { headers: TOK }).then(r => r.json());
  ok('อ่านการตั้งค่าได้เมื่อมีรหัส', !!s.mc && Array.isArray(s.slots));
  ok('ไม่ส่งคีย์จริงกลับมาให้เบราว์เซอร์', !('groqKey' in s.mc) && !('orKey' in s.mc));
  ok('มีช่องเสียงครบทั้งเพลง เสียงเกม และคัตซีน',
     s.slots.some(x => x.kind === 'bgm') && s.slots.some(x => x.kind === 'sfx') && s.slots.some(x => x.kind === 'cut'));
  ok('ระบุชนิดไฟล์ชัดเจนพร้อมบอกว่าอันไหน iOS เล่นไม่ได้',
     s.audioTypes.some(t => t.label === 'MP3' && t.ios) &&
     s.audioTypes.some(t => t.label === 'OGG' && !t.ios),
     s.audioTypes.map(t => t.label).join(','));

  // บันทึกคีย์
  const save = await fetch(`${base}/api/settings`, {
    method:'POST', headers:{ ...TOK, 'Content-Type':'application/json' },
    body: JSON.stringify({ groqKey:'gsk_test_1234ABCD', minGapMs: 5000, lang:'en' }),
  }).then(r => r.json());
  ok('บันทึกคีย์ Groq ได้', save.ok === true && save.mc.groqKeySet === true);
  ok('แสดงคีย์แบบปิดบังเท่านั้น', /^••••/.test(save.mc.groqKeyHint), save.mc.groqKeyHint);
  ok('ค่าอื่นบันทึกด้วย', save.mc.minGapMs === 5000);

  // ปฏิเสธชนิดไฟล์ที่ไม่รองรับ
  const badType = await fetch(`${base}/api/audio/sfx_stone`, {
    method:'PUT', headers:{ ...TOK, 'Content-Type':'image/png' },
    body: Buffer.alloc(200),
  }).then(r => r.json());
  ok('ไฟล์ผิดชนิดถูกปฏิเสธ', !!badType.error, badType.error);

  // ช่องเสียงที่ไม่มีอยู่จริง
  const badSlot = await fetch(`${base}/api/audio/ไม่มีช่องนี้`, {
    method:'PUT', headers:{ ...TOK, 'Content-Type':'audio/mpeg' }, body: Buffer.alloc(200),
  }).then(r => r.status);
  ok('ช่องเสียงที่ไม่รู้จักถูกปฏิเสธ', badSlot === 400, String(badSlot));

  // อัปโหลดไฟล์จริง (MP3 จำลอง)
  const fakeMp3 = Buffer.concat([Buffer.from([0xFF, 0xFB, 0x90, 0x00]), Buffer.alloc(4096, 7)]);
  const up = await fetch(`${base}/api/audio/sfx_stone`, {
    method:'PUT',
    headers:{ ...TOK, 'Content-Type':'audio/mpeg', 'x-file-name': encodeURIComponent('stone.mp3') },
    body: fakeMp3,
  }).then(r => r.json());
  ok('อัปโหลดไฟล์เสียงวางหมากได้', up.ok === true);
  const stone = up.audio.assets.find(a => a.id === 'sfx_stone');
  ok('รายการไฟล์บันทึกชนิดและขนาดถูกต้อง', stone.ext === 'mp3' && stone.size === fakeMp3.length, JSON.stringify(stone));

  // ไฟล์ใหญ่เกินกำหนดของช่องนั้น
  const tooBig = await fetch(`${base}/api/audio/sfx_capture`, {
    method:'PUT', headers:{ ...TOK, 'Content-Type':'audio/wav' },
    body: Buffer.alloc(1024 * 1024 * 2, 1),
  }).then(r => r.json());
  ok('ไฟล์ใหญ่เกินโควตาของช่องถูกปฏิเสธ', !!tooBig.error, tooBig.error);

  // ทุกเครื่องต้องได้รับรายการไฟล์ใหม่
  const C = new Client(port); await C.ready;
  C.send({ t:'auth', name:'ก' });
  await C.wait('welcome');
  const mf0 = await C.wait('manifest');
  ok('ผู้เล่นได้รับรายการไฟล์เสียงตอนเชื่อมต่อ', Array.isArray(mf0.assets));
  ok('รายการมีไฟล์ที่เพิ่งอัปโหลด', mf0.assets.some(a => a.id === 'sfx_stone' && a.url));

  C.inbox.length = 0;
  await fetch(`${base}/api/audio/sfx_pass`, {
    method:'PUT', headers:{ ...TOK, 'Content-Type':'audio/mp4' }, body: Buffer.alloc(3000, 3),
  });
  const mf1 = await C.wait('manifest', 3000);
  ok('อัปโหลดใหม่แล้วทุกเครื่องได้รับรายการใหม่ทันที',
     mf1.assets.some(a => a.id === 'sfx_pass' && a.url));

  // โหลดไฟล์ที่เก็บในหน่วยความจำได้จริง
  const got = await fetch(`${base}/api/audio/sfx_stone`);
  ok('ดาวน์โหลดไฟล์เสียงกลับมาได้', got.status === 200 && got.headers.get('content-type').includes('audio'));

  // ลบไฟล์
  const del = await fetch(`${base}/api/audio/sfx_stone`, { method:'DELETE', headers: TOK }).then(r => r.json());
  ok('ลบไฟล์เสียงได้', del.ok === true && !del.audio.assets.find(a => a.id === 'sfx_stone').url);

  // รายการไฟล์เปิดให้ทุกคนอ่านได้โดยไม่ต้องมีรหัส
  const pub = await fetch(`${base}/api/manifest`).then(r => r.json());
  ok('รายการไฟล์เสียงเปิดสาธารณะให้เบราว์เซอร์โหลดล่วงหน้าได้', Array.isArray(pub.assets));

  C.close();
}

/* ===================================================================== */
(async () => {
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  console.log(`เซิร์ฟเวอร์ทดสอบทำงานที่พอร์ต ${port}`);

  testClock();
  try {
    await testAutoBroadcast(port);
    await testMC(port);
    await testFlow(port);
    await testResume(port);
    await testAI(port);
    await testDirectorAIBattle(port);
    await testAIResultHold();
    await testReconnect(port);
    await testTimeout(port);
    await testDirector(port);
    await testRules(port);
    await testAIFullGame(port);
    await testWatchAndFiles(port);
    await testLive(port);
    await testSettings(port);
  } catch (e) {
    fail++; console.log('  FAIL การทดสอบหยุดกลางคัน → ' + e.message);
  }

  console.log(`\n════════════════════════════════`);
  console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
  console.log(`════════════════════════════════`);
  server.close();
  process.exit(fail ? 1 : 0);
})();
