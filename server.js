/* =====================================================================
 * GO BATTLE LIVE — server.js  v1.0
 * เซิร์ฟเวอร์เกมกลาง (authoritative) — Node.js + ws
 * ดีพลอยบน Render แผน Starter ($7/เดือน) เพื่อไม่ให้เครื่องหลับ
 *
 * หน้าที่:
 *   - ถือ state ของทุกห้อง (ไม่มี P2P, ไม่มีการย้ายโฮสต์)
 *   - เป็นเจ้าของนาฬิกาแต่เพียงผู้เดียว (แก้บั๊กนาฬิกาเดินสองเท่าถาวร)
 *   - ตรวจความถูกต้องของทุกตาด้วย go-engine
 *   - กระจาย event เสียง/อีโมจิให้ทุกเครื่องพร้อมกัน
 *   - เขียนผลเกมและปรับดั้งลง Supabase
 *   - ป้อนรายชื่อห้องให้หน้าเบื้องหลัง และบอกว่าห้องไหนกำลังออกอากาศ
 *
 * ตัวแปรสภาพแวดล้อม (Environment Variables):
 *   PORT                       (Render ใส่ให้เอง)
 *   SUPABASE_URL               https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY       service_role key  ** ห้ามหลุดไปฝั่งเบราว์เซอร์ **
 *   DIRECTOR_TOKEN             รหัสลับสำหรับหน้าเบื้องหลัง
 * ถ้าไม่ใส่ค่า Supabase เซิร์ฟเวอร์จะทำงานได้ปกติแต่ไม่บันทึกลงฐานข้อมูล
 * (โหมดนี้ใช้สำหรับรันทดสอบในเครื่อง)
 * ===================================================================== */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { GoGame, BLACK, WHITE, KOMI_BY_SIZE } = require('./go-engine.js');
const AI = require('./ai-light.js');

const PORT            = process.env.PORT || 3000;
const SUPABASE_URL    = process.env.SUPABASE_URL || '';
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const DIRECTOR_TOKEN  = process.env.DIRECTOR_TOKEN || 'dev-director';
const DB_ON           = !!(SUPABASE_URL && SUPABASE_KEY);
const AI_DELAY_MS     = Number(process.env.AI_DELAY_MS ?? 600);   // หน่วงให้ AI ดูเหมือนกำลังคิด

const RECONNECT_GRACE_MS = 60_000;
const TICK_MS            = 250;

/* =====================================================================
 * ส่วนที่ 1 — ตัวช่วยคุยกับ Supabase (ใช้ fetch ล้วน ไม่ต้องลง SDK)
 * ===================================================================== */
async function db(pathname, { method = 'GET', body, prefer } = {}) {
  if (!DB_ON) return null;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { console.error('[db]', method, pathname, res.status, await res.text()); return null; }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) { console.error('[db] error', e.message); return null; }
}

async function rpc(fn, args) {
  if (!DB_ON) return null;
  return db(`rpc/${fn}`, { method: 'POST', body: args });
}

// ตรวจ JWT ของผู้ใช้ที่ล็อกอินผ่าน Supabase Auth ฝั่งเบราว์เซอร์
async function verifyUser(accessToken) {
  if (!DB_ON || !accessToken) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    const rows = await db(`profiles?id=eq.${u.id}&select=*`);
    return { id: u.id, email: u.email, profile: rows?.[0] || null };
  } catch { return null; }
}

async function loadRating(userId, size) {
  const rows = await db(`ratings?user_id=eq.${userId}&board_size=eq.${size}&select=*`);
  if (rows && rows.length) return rows[0];
  await db('ratings', {
    method: 'POST', prefer: 'resolution=ignore-duplicates',
    body: { user_id: userId, board_size: size },
  });
  return { user_id: userId, board_size: size, gor: 100, games_played: 0, is_provisional: true };
}

function gorToLabel(gor) {
  if (gor == null) return '—';
  if (gor >= 2100) return `${Math.min(9, Math.floor((gor - 2000) / 100))} ดั้ง`;
  return `${Math.min(30, Math.max(1, Math.ceil((2100 - gor) / 100)))} คิว`;
}

/* =====================================================================
 * ส่วนที่ 2 — นาฬิกา (เวลาหลัก + เบียวโยมิ)
 * ===================================================================== */
function newClock(rule) {
  return {
    mainMs:     (rule.main ?? 300) * 1000,
    byoyomiMs:  (rule.byoyomi ?? 30) * 1000,
    periods:     rule.periods ?? 3,
    inByoyomi:  (rule.main ?? 300) === 0,
    periodMs:   (rule.byoyomi ?? 30) * 1000,
  };
}

// หักเวลาที่ใช้ไป คืน true ถ้าหมดเวลา
function consume(clock, elapsedMs) {
  if (!clock.inByoyomi) {
    clock.mainMs -= elapsedMs;
    if (clock.mainMs > 0) return false;
    // เวลาหลักหมด เข้าเบียวโยมิ
    const over = -clock.mainMs;
    clock.mainMs = 0;
    clock.inByoyomi = true;
    clock.periodMs = clock.byoyomiMs;
    return consumeByoyomi(clock, over);
  }
  return consumeByoyomi(clock, elapsedMs);
}

function consumeByoyomi(clock, elapsedMs) {
  if (clock.byoyomiMs === 0) return true;              // ไม่มีเบียวโยมิ = หมดเวลาทันที
  if (elapsedMs <= clock.byoyomiMs) {
    clock.periodMs = clock.byoyomiMs;                  // เดินทันในรอบ -> รีเซ็ตรอบ
    return false;
  }
  let used = elapsedMs;
  while (used > clock.byoyomiMs && clock.periods > 0) {
    used -= clock.byoyomiMs;
    clock.periods -= 1;
  }
  if (clock.periods <= 0) return true;
  clock.periodMs = clock.byoyomiMs;
  return false;
}

function remainingMs(clock, elapsedMs) {
  if (!clock.inByoyomi) {
    const left = clock.mainMs - elapsedMs;
    if (left > 0) return { main: left, byoyomi: null, periods: clock.periods };
    return { main: 0, byoyomi: Math.max(0, clock.byoyomiMs + left), periods: clock.periods };
  }
  return { main: 0, byoyomi: Math.max(0, clock.periodMs - elapsedMs), periods: clock.periods };
}

/* =====================================================================
 * ส่วนที่ 3 — ห้อง
 * ===================================================================== */
const directors   = new Set();   // หน้าเบื้องหลัง
const liveViewers = new Set();   // หน้าออกอากาศ (OBS / TikTok Live Studio)

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // ตัด I O 0 1 ที่สับสน
const rooms = new Map();          // code -> room
let programRoom = null;           // ห้องที่กำลังออกอากาศ
let autoProgram = false;          // สลับห้องอัตโนมัติ (ใช้ตอนไม่มีคนคุมหน้าเบื้องหลัง)
let lastAutoSwitch = 0;
const AUTO_DWELL_MS = Number(process.env.AUTO_DWELL_MS ?? 30_000);   // ค้างห้องละอย่างน้อย 30 วินาที

function makeCode() {
  let c;
  do { c = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function createRoom(opts) {
  const size     = [9, 13, 19].includes(opts.size) ? opts.size : 9;
  const handicap = Math.max(0, Math.min(9, opts.handicap | 0));
  const timeRule = {
    main:     Math.max(0, opts.timeRule?.main     ?? 300),
    byoyomi:  Math.max(0, opts.timeRule?.byoyomi  ?? 30),
    periods:  Math.max(0, opts.timeRule?.periods  ?? 3),
  };
  const room = {
    code: makeCode(),
    game: new GoGame({ size, komi: handicap >= 2 ? 0 : KOMI_BY_SIZE[size], handicap }),
    timeRule,
    clocks: { [BLACK]: newClock(timeRule), [WHITE]: newClock(timeRule) },
    turnStartedAt: null,
    seats: { [BLACK]: null, [WHITE]: null },     // {userId,name,gor,token,ws,ai}
    spectators: new Set(),
    state: 'waiting',                            // waiting|ready|playing|marking|finished
    ready: { [BLACK]: false, [WHITE]: false },
    dead: new Set(),
    confirms: { [BLACK]: false, [WHITE]: false },
    disconnectAt: { [BLACK]: null, [WHITE]: null },
    gameId: null,
    createdAt: Date.now(),
    heat: 0,
    recentCaptures: [],
  };
  rooms.set(room.code, room);
  return room;
}

function seatOf(room, ws) {
  if (room.seats[BLACK]?.ws === ws) return BLACK;
  if (room.seats[WHITE]?.ws === ws) return WHITE;
  return null;
}

function everyone(room) {
  const list = [];
  for (const c of [BLACK, WHITE]) if (room.seats[c]?.ws) list.push(room.seats[c].ws);
  for (const s of room.spectators) list.push(s);
  return list;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of everyone(room)) if (ws.readyState === 1) ws.send(msg);
  for (const d of directors) {
    if (d.readyState === 1 && d.watching && d.watching.has(room.code) && !everyone(room).includes(d)) {
      d.send(msg);
    }
  }
  if (programRoom === room.code) {
    for (const v of liveViewers) if (v.readyState === 1) v.send(msg);
  }
}

function publicState(room) {
  const el = room.turnStartedAt ? Date.now() - room.turnStartedAt : 0;
  const cur = room.game.turn;
  return {
    code: room.code,
    state: room.state,
    game: room.game.snapshot(),
    players: {
      black: room.seats[BLACK] && { name: room.seats[BLACK].name, rank: gorToLabel(room.seats[BLACK].gor), ai: !!room.seats[BLACK].ai, online: !!room.seats[BLACK].ws },
      white: room.seats[WHITE] && { name: room.seats[WHITE].name, rank: gorToLabel(room.seats[WHITE].gor), ai: !!room.seats[WHITE].ai, online: !!room.seats[WHITE].ws },
    },
    ready: { black: room.ready[BLACK], white: room.ready[WHITE] },
    clocks: {
      black: remainingMs(room.clocks[BLACK], cur === BLACK ? el : 0),
      white: remainingMs(room.clocks[WHITE], cur === WHITE ? el : 0),
    },
    dead: [...room.dead],
    confirms: { black: room.confirms[BLACK], white: room.confirms[WHITE] },
    timeRule: room.timeRule,
    onAir: programRoom === room.code,
  };
}

function pushState(room) { broadcast(room, { t: 'state', ...publicState(room) }); }

// ตั้งห้องที่ออกอากาศ ส่ง null = จอดำ
function setProgram(code, transition = 'ink') {
  programRoom = code;
  for (const d of directors)   send(d, { t: 'program', code: programRoom, auto: autoProgram });
  for (const v of liveViewers) send(v, { t: 'program', code: programRoom, transition, auto: autoProgram });
  const room = code && rooms.get(code);
  if (room) {
    for (const v of liveViewers) send(v, { t: 'state', ...publicState(room) });
    pushState(room);
  }
}

/* ---------- ค่าความมัน สำหรับหน้าเบื้องหลัง ---------- */
function updateHeat(room, capturedCount) {
  const now = Date.now();
  if (capturedCount) room.recentCaptures.push({ at: now, n: capturedCount });
  room.recentCaptures = room.recentCaptures.filter(c => now - c.at < 120_000);
  let h = room.recentCaptures.reduce((a, c) => a + c.n, 0) * 3;
  for (const c of [BLACK, WHITE]) {
    const cl = room.clocks[c];
    if (cl.inByoyomi) h += 8;
  }
  if (room.game.history.length > 10) h += 4;
  room.heat = Math.min(100, h);
}

/* =====================================================================
 * ส่วนที่ 4 — วงจรเกม
 * ===================================================================== */
function tryStart(room) {
  if (room.state !== 'waiting' && room.state !== 'ready') return;
  if (!room.seats[BLACK] || !room.seats[WHITE]) return;
  if (!room.ready[BLACK] || !room.ready[WHITE]) { room.state = 'ready'; return; }
  room.state = 'playing';
  room.turnStartedAt = Date.now();
  broadcast(room, { t: 'sfx', id: 'game_start' });
  pushState(room);
  maybeAIMove(room);
}

function applyElapsed(room) {
  const c = room.game.turn;
  const elapsed = Date.now() - room.turnStartedAt;
  const out = consume(room.clocks[c], elapsed);
  room.turnStartedAt = Date.now();
  return out;   // true = หมดเวลา
}

function endGame(room, result, extra = {}) {
  room.state = 'finished';
  room.game.state = 'finished';
  room.game.result = result;
  room.turnStartedAt = null;
  broadcast(room, { t: 'end', result, ...extra, ...publicState(room) });
  broadcast(room, { t: 'sfx', id: 'game_end' });
  saveGame(room, result).catch(e => console.error('[save]', e.message));
}

function timeoutLoss(room) {
  const loser = room.game.turn;
  endGame(room, {
    type: loser === BLACK ? 'white_win' : 'black_win',
    text: loser === BLACK ? 'W+T' : 'B+T',
    reason: 'หมดเวลา',
  });
}

function doPlay(room, color, x, y) {
  if (room.state !== 'playing') return { error: 'ยังไม่เริ่มเล่น' };
  if (room.game.turn !== color) return { error: 'ยังไม่ถึงตาของคุณ' };
  if (applyElapsed(room)) { timeoutLoss(room); return { handled: true }; }

  const r = room.game.play(x, y, color);
  if (!r.ok) { room.turnStartedAt = Date.now(); return { error: r.error }; }

  updateHeat(room, r.captured.length);
  broadcast(room, { t: 'sfx', id: r.captured.length ? 'capture' : 'stone' });

  if (r.noResult) {
    endGame(room, { type: 'no_result', text: 'ไม่มีผลแพ้ชนะ', reason: 'ตำแหน่งซ้ำ (ซันโคะ)' });
    return { handled: true };
  }
  pushState(room);
  maybeAIMove(room);
  return { handled: true };
}

function doPass(room, color) {
  if (room.state !== 'playing') return { error: 'ยังไม่เริ่มเล่น' };
  if (room.game.turn !== color) return { error: 'ยังไม่ถึงตาของคุณ' };
  if (applyElapsed(room)) { timeoutLoss(room); return { handled: true }; }

  const r = room.game.pass(color);
  if (!r.ok) { return { error: r.error }; }
  broadcast(room, { t: 'sfx', id: 'pass' });

  if (r.enterMarking) {
    // กติกาญี่ปุ่น: หยุดนาฬิกาแล้วเข้าเฟสตกลงหมากตาย
    room.state = 'marking';
    room.turnStartedAt = null;
    room.dead = new Set(r.deadGuess);
    room.confirms = { [BLACK]: false, [WHITE]: false };
    // ฝั่ง AI ยืนยันให้อัตโนมัติ
    for (const c of [BLACK, WHITE]) if (room.seats[c]?.ai) room.confirms[c] = true;
    pushState(room);
    checkScoreConfirm(room);
    return { handled: true };
  }
  pushState(room);
  maybeAIMove(room);
  return { handled: true };
}

function checkScoreConfirm(room) {
  if (room.state !== 'marking') return;
  if (!(room.confirms[BLACK] && room.confirms[WHITE])) return;
  const result = room.game.finalize([...room.dead]);
  endGame(room, result, { score: result.score });
}

function maybeAIMove(room) {
  if (room.state !== 'playing') return;
  const c = room.game.turn;
  const seat = room.seats[c];
  if (!seat?.ai) return;
  const delay = AI_DELAY_MS + Math.random() * AI_DELAY_MS * 2;   // ให้ดูเหมือนกำลังคิด
  setTimeout(() => {
    if (room.state !== 'playing' || room.game.turn !== c) return;
    const mv = AI.chooseMove(room.game, c, seat.ai.strength);
    if (mv.pass) doPass(room, c); else doPlay(room, c, mv.x, mv.y);
  }, delay);
}

/* ---------- บันทึกผลลงฐานข้อมูล + ปรับดั้ง ---------- */
async function saveGame(room, result) {
  if (!DB_ON) return;
  const b = room.seats[BLACK], w = room.seats[WHITE];
  const isAI = !!(b?.ai || w?.ai);

  let rated = !isAI;
  if (!isAI && b?.userId && w?.userId) {
    const ok = await rpc('should_rate_game', { p_a: b.userId, p_b: w.userId, p_board_size: room.game.size });
    rated = ok !== false;
    if (room.game.history.length < 10 && result.reason === 'ยอมแพ้') rated = false;
  }

  const row = {
    room_code: room.code,
    black_id: b?.userId ?? null,
    white_id: w?.userId ?? null,
    is_ai_game: isAI,
    ai_opponent_id: b?.ai?.id ?? w?.ai?.id ?? null,
    ai_plays_color: b?.ai ? 'B' : (w?.ai ? 'W' : null),
    board_size: room.game.size,
    komi: room.game.komi,
    handicap: room.game.handicap,
    time_rule: room.timeRule,
    result: result.type,
    result_text: result.text,
    score_black: result.score?.black ?? null,
    score_white: result.score?.white ?? null,
    sgf: room.game.toSGF({
      playerBlack: b?.name, playerWhite: w?.name,
      blackRank: gorToLabel(b?.gor), whiteRank: gorToLabel(w?.gor),
      event: 'Go Battle Live', date: new Date().toISOString().slice(0, 10),
    }),
    rated,
    ended_at: new Date().toISOString(),
  };
  const saved = await db('games', { method: 'POST', prefer: 'return=representation', body: row });
  const gameId = saved?.[0]?.id;
  if (!gameId) return;

  const moves = room.game.history.map((m, i) => ({
    game_id: gameId, seq: i + 1,
    color: m.color === BLACK ? 'B' : 'W',
    x: m.pass ? null : m.x, y: m.pass ? null : m.y, is_pass: !!m.pass,
  }));
  if (moves.length) await db('moves', { method: 'POST', body: moves });

  if (rated && b?.userId && w?.userId && (result.type === 'black_win' || result.type === 'white_win')) {
    await rpc('apply_game_rating', {
      p_game_id: gameId,
      p_board_size: room.game.size,
      p_black_id: b.userId,
      p_white_id: w.userId,
      p_black_won: result.type === 'black_win',
      p_weight: isAI ? 0.5 : 1.0,
    });
  }
}

/* ---------- เลือกห้องขึ้นออกอากาศเอง เมื่อไม่มีผู้กำกับคุม ---------- */
function autoPickRoom() {
  if (!autoProgram) return;
  const now = Date.now();
  const cur = programRoom && rooms.get(programRoom);

  // ห้องปัจจุบันยังเล่นอยู่และยังไม่ครบเวลาค้าง -> ไม่ต้องสลับ
  if (cur && cur.state !== 'finished' && now - lastAutoSwitch < AUTO_DWELL_MS) return;

  const all = [...rooms.values()];
  const playing = all.filter(r => r.state === 'playing');
  const waiting = all.filter(r => r.state === 'waiting' || r.state === 'ready' || r.state === 'marking');

  let pick = null;
  if (playing.length) pick = playing.reduce((a, b) => (b.heat > a.heat ? b : a));
  else if (waiting.length) pick = waiting[0];

  // ห้องที่เพิ่งจบ ค้างภาพจอผลไว้อีก 8 วินาทีก่อนสลับ
  if (cur && cur.state === 'finished' && now - lastAutoSwitch < AUTO_DWELL_MS + 8000 && pick && pick.code !== cur.code) return;

  if (!pick) { if (programRoom) { lastAutoSwitch = now; setProgram(null, 'fade'); } return; }
  if (pick.code === programRoom) return;
  lastAutoSwitch = now;
  setProgram(pick.code, 'ink');
}

/* =====================================================================
 * ส่วนที่ 5 — ตัวจับเวลาหลัก
 * ===================================================================== */
setInterval(() => {
  const now = Date.now();
  autoPickRoom();
  for (const room of rooms.values()) {
    if (room.state === 'playing' && room.turnStartedAt) {
      const c = room.game.turn;
      const left = remainingMs(room.clocks[c], now - room.turnStartedAt);
      const dead = !room.clocks[c].inByoyomi
        ? (left.main === 0 && left.byoyomi === 0 && room.clocks[c].periods <= 0)
        : (left.byoyomi === 0 && room.clocks[c].periods <= 1);
      if (dead) { timeoutLoss(room); continue; }
    }
    // ผู้เล่นหลุดเกิน 60 วินาที = ปรับแพ้
    for (const c of [BLACK, WHITE]) {
      const at = room.disconnectAt[c];
      if (at && now - at > RECONNECT_GRACE_MS && room.state === 'playing') {
        endGame(room, {
          type: c === BLACK ? 'white_win' : 'black_win',
          text: c === BLACK ? 'W+F' : 'B+F',
          reason: 'ผู้เล่นหลุดเกินเวลาที่กำหนด',
        });
      }
    }
    // เก็บกวาดห้องร้าง
    if (everyone(room).length === 0 && now - room.createdAt > 10 * 60_000) {
      rooms.delete(room.code);
      if (programRoom === room.code) setProgram(null);
    }
  }
}, TICK_MS);

/* =====================================================================
 * ส่วนที่ 6 — HTTP + WebSocket
 * ===================================================================== */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/api/rooms') {
    const list = [...rooms.values()].map(r => ({
      code: r.code, state: r.state, size: r.game.size,
      moves: r.game.history.length, heat: r.heat,
      black: r.seats[BLACK]?.name ?? null, white: r.seats[WHITE]?.name ?? null,
      onAir: programRoom === r.code,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rooms: list, program: programRoom }));
  }
  // เอนจินโกะใช้ร่วมกันระหว่างเซิร์ฟเวอร์กับเบราว์เซอร์ (ตรวจตาผิดกติกาได้ทันทีฝั่งผู้เล่น)
  if (url.pathname === '/go-engine.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'go-engine.js')));
  }
  // เสิร์ฟไฟล์ static ใน public/
  let p = url.pathname === '/' ? '/index.html'
        : url.pathname === '/live' ? '/live.html'
        : url.pathname === '/director' ? '/director.html'
        : url.pathname;
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.room = null;
  ws.identity = null;

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try { await handle(ws, m); }
    catch (e) { console.error('[handle]', e); send(ws, { t: 'error', msg: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์' }); }
  });

  ws.on('close', () => {
    directors.delete(ws);
    liveViewers.delete(ws);
    const room = ws.room && rooms.get(ws.room);
    if (!room) return;
    room.spectators.delete(ws);
    const c = seatOf(room, ws);
    if (c) {
      room.seats[c].ws = null;
      room.disconnectAt[c] = Date.now();
      pushState(room);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30_000);

async function handle(ws, m) {
  switch (m.t) {

    /* ---- ยืนยันตัวตน: สมาชิก Supabase หรือผู้มาเยือน ---- */
    case 'auth': {
      let identity = null;
      if (m.accessToken) {
        const u = await verifyUser(m.accessToken);
        if (u) identity = { userId: u.id, name: u.profile?.display_name || u.email?.split('@')[0] || 'ผู้เล่น', guest: false };
      }
      if (!identity) {
        identity = { userId: null, name: (m.name || 'ผู้มาเยือน').slice(0, 24), guest: true };
      }
      identity.token = m.playerToken || Math.random().toString(36).slice(2) + Date.now().toString(36);
      ws.identity = identity;
      send(ws, { t: 'welcome', playerToken: identity.token, name: identity.name, guest: identity.guest, dbOn: DB_ON });
      return;
    }

    /* ---- สร้างห้อง ---- */
    case 'create': {
      if (!ws.identity) return send(ws, { t: 'error', msg: 'ยังไม่ได้ยืนยันตัวตน' });
      const room = createRoom(m);
      const color = m.color === 'W' ? WHITE : BLACK;
      let gor = 100;
      if (ws.identity.userId) gor = (await loadRating(ws.identity.userId, room.game.size))?.gor ?? 100;
      room.seats[color] = { ...ws.identity, gor, ws };
      ws.room = room.code;

      if (m.vsAI) {
        const ai = m.ai || { id: 'seed15k', name: 'น้องเมล็ด', rank: '15 คิว', strength: 0.32 };
        const other = color === BLACK ? WHITE : BLACK;
        room.seats[other] = { userId: null, name: ai.name, gor: ai.gor ?? 600, ws: null, ai };
        room.ready[other] = true;
      }
      send(ws, { t: 'joined', code: room.code, color: color === BLACK ? 'B' : 'W' });
      pushState(room);
      return;
    }

    /* ---- เข้าห้อง / กลับเข้าห้องหลังหลุด ---- */
    case 'join': {
      if (!ws.identity) return send(ws, { t: 'error', msg: 'ยังไม่ได้ยืนยันตัวตน' });
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'ไม่พบห้องนี้' });

      // กลับเข้าที่นั่งเดิม
      for (const c of [BLACK, WHITE]) {
        if (room.seats[c] && room.seats[c].token === ws.identity.token) {
          room.seats[c].ws = ws; room.disconnectAt[c] = null; ws.room = room.code;
          send(ws, { t: 'joined', code: room.code, color: c === BLACK ? 'B' : 'W', reconnected: true });
          pushState(room);
          return;
        }
      }
      // นั่งที่ว่าง
      const free = !room.seats[BLACK] ? BLACK : (!room.seats[WHITE] ? WHITE : null);
      if (free === null) {
        room.spectators.add(ws); ws.room = room.code;
        send(ws, { t: 'joined', code: room.code, color: null, spectator: true });
        pushState(room);
        return;
      }
      let gor = 100;
      if (ws.identity.userId) gor = (await loadRating(ws.identity.userId, room.game.size))?.gor ?? 100;
      room.seats[free] = { ...ws.identity, gor, ws };
      ws.room = room.code;
      send(ws, { t: 'joined', code: room.code, color: free === BLACK ? 'B' : 'W' });
      broadcast(room, { t: 'sfx', id: 'player_join' });
      pushState(room);
      return;
    }

    case 'ready': {
      const room = rooms.get(ws.room); if (!room) return;
      const c = seatOf(room, ws); if (!c) return;
      room.ready[c] = m.value !== false;
      pushState(room);
      tryStart(room);
      return;
    }

    case 'play': {
      const room = rooms.get(ws.room); if (!room) return;
      const c = seatOf(room, ws); if (!c) return send(ws, { t: 'error', msg: 'คุณเป็นผู้ชม' });
      const r = doPlay(room, c, m.x | 0, m.y | 0);
      if (r.error) send(ws, { t: 'error', msg: r.error });
      return;
    }

    case 'pass': {
      const room = rooms.get(ws.room); if (!room) return;
      const c = seatOf(room, ws); if (!c) return;
      const r = doPass(room, c);
      if (r.error) send(ws, { t: 'error', msg: r.error });
      return;
    }

    case 'resign': {
      const room = rooms.get(ws.room); if (!room) return;
      const c = seatOf(room, ws); if (!c) return;
      if (room.state !== 'playing') return;
      endGame(room, room.game.resign(c));
      return;
    }

    /* ---- เฟสตกลงหมากตาย ---- */
    case 'toggle_dead': {
      const room = rooms.get(ws.room); if (!room || room.state !== 'marking') return;
      const c = seatOf(room, ws); if (!c) return;
      const g = room.game.group(m.x | 0, m.y | 0);
      if (!g) return;
      const on = room.dead.has(g.stones[0]);
      for (const s of g.stones) { if (on) room.dead.delete(s); else room.dead.add(s); }
      room.confirms = { [BLACK]: !!room.seats[BLACK]?.ai, [WHITE]: !!room.seats[WHITE]?.ai };
      pushState(room);
      return;
    }

    case 'confirm_score': {
      const room = rooms.get(ws.room); if (!room || room.state !== 'marking') return;
      const c = seatOf(room, ws); if (!c) return;
      room.confirms[c] = true;
      pushState(room);
      checkScoreConfirm(room);
      return;
    }

    case 'resume_play': {   // ตกลงกันไม่ได้ -> กลับไปเล่นต่อ
      const room = rooms.get(ws.room); if (!room || room.state !== 'marking') return;
      room.state = 'playing';
      room.game.state = 'playing';
      room.game.passes = 0;
      room.dead.clear();
      room.confirms = { [BLACK]: false, [WHITE]: false };
      room.turnStartedAt = Date.now();
      pushState(room);
      maybeAIMove(room);
      return;
    }

    case 'emoji': {
      const room = rooms.get(ws.room); if (!room) return;
      broadcast(room, { t: 'emoji', id: String(m.id).slice(0, 32), from: ws.identity?.name });
      return;
    }

    /* ---- หน้าเบื้องหลัง ---- */
    case 'director_auth': {
      if (m.token !== DIRECTOR_TOKEN) return send(ws, { t: 'error', msg: 'รหัสผู้กำกับไม่ถูกต้อง' });
      directors.add(ws);
      send(ws, { t: 'director_ok', program: programRoom });
      return;
    }

    /* ---- หน้าออกอากาศ: รับภาพของห้องที่กำลังออกอากาศเท่านั้น ---- */
    case 'live': {
      liveViewers.add(ws);
      // โหมดอัตโนมัติ: ใช้ตอนถ่ายทอดด้วยมือถือเครื่องเดียว ไม่มีคนคุมหน้าเบื้องหลัง
      if (m.auto) { autoProgram = true; autoPickRoom(); }
      send(ws, { t: 'program', code: programRoom, auto: autoProgram });
      const room = programRoom && rooms.get(programRoom);
      if (room) send(ws, { t: 'state', ...publicState(room) });
      return;
    }

    /* ---- ผู้กำกับขอรับภาพหลายห้องพร้อมกัน (ไม่นั่งเป็นผู้เล่น) ---- */
    case 'watch': {
      if (!directors.has(ws)) return send(ws, { t: 'error', msg: 'ไม่มีสิทธิ์' });
      ws.watching = new Set((m.codes || []).map(c => String(c).toUpperCase()));
      for (const code of ws.watching) {
        const room = rooms.get(code);
        if (room) send(ws, { t: 'state', ...publicState(room) });
      }
      return;
    }

    /* ---- เข้าชมอย่างเดียว ไม่นั่งที่ผู้เล่นแม้ที่ว่าง ---- */
    case 'spectate': {
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'ไม่พบห้องนี้' });
      const prev = ws.room && rooms.get(ws.room);
      if (prev) prev.spectators.delete(ws);
      room.spectators.add(ws); ws.room = room.code;
      send(ws, { t: 'joined', code: room.code, color: null, spectator: true });
      send(ws, { t: 'state', ...publicState(room) });
      return;
    }

    /* ---- ผู้กำกับยิงคัตซีนค่ายกล / ข้อความ MC ขึ้นภาพออกอากาศ ---- */
    case 'highlight': {
      if (!directors.has(ws)) return send(ws, { t: 'error', msg: 'ไม่มีสิทธิ์' });
      const payload = {
        t: 'highlight',
        nameTh: String(m.nameTh || 'ค่ายกล').slice(0, 40),
        nameJa: String(m.nameJa || '').slice(0, 40),
        tier: ['R', 'SR', 'SSR'].includes(m.tier) ? m.tier : 'SR',
        coords: Array.isArray(m.coords) ? m.coords.slice(0, 40) : [],
      };
      for (const v of liveViewers) send(v, payload);
      return;
    }

    case 'mc': {
      if (!directors.has(ws)) return send(ws, { t: 'error', msg: 'ไม่มีสิทธิ์' });
      const payload = { t: 'mc', text: String(m.text || '').slice(0, 200) };
      for (const v of liveViewers) send(v, payload);
      return;
    }

    case 'auto': {
      if (!directors.has(ws)) return send(ws, { t: 'error', msg: 'ไม่มีสิทธิ์' });
      autoProgram = m.value !== false;
      lastAutoSwitch = 0;
      autoPickRoom();
      for (const d of directors) send(d, { t: 'auto', value: autoProgram });
      return;
    }

    case 'program': {
      if (!directors.has(ws)) return send(ws, { t: 'error', msg: 'ไม่มีสิทธิ์' });
      autoProgram = false;        // ผู้กำกับสั่งเอง = ปิดโหมดอัตโนมัติ
      if (!m.code) { setProgram(null, m.transition || 'fade'); return; }   // จอดำ
      const room = rooms.get(String(m.code).toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'ไม่พบห้องนี้' });
      setProgram(room.code, m.transition || 'ink');
      return;
    }

    default:
      send(ws, { t: 'error', msg: 'คำสั่งไม่ถูกต้อง' });
  }
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Go Battle Live — พร้อมใช้งานที่พอร์ต ${PORT}`);
    console.log(`ฐานข้อมูล Supabase: ${DB_ON ? 'เชื่อมต่อแล้ว' : 'ยังไม่ได้ตั้งค่า (โหมดทดสอบในเครื่อง)'}`);
  });
}

module.exports = { server, rooms, createRoom, newClock, consume, remainingMs, gorToLabel };
