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
 *   KATAGO_API_URL             HTTPS endpoint สำหรับ Neural Superhuman (Vercel)
 *   KATAGO_API_KEY             Bearer key ของ endpoint
 * หรือ KATAGO_BIN + KATAGO_MODEL + KATAGO_CONFIG สำหรับ process แบบ long-running
 * ถ้าไม่ใส่ค่า Supabase เซิร์ฟเวอร์จะทำงานได้ปกติแต่ไม่บันทึกลงฐานข้อมูล
 * (โหมดนี้ใช้สำหรับรันทดสอบในเครื่อง)
 * ===================================================================== */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { GoGame, BLACK, WHITE, KOMI_BY_SIZE } = require('./go-engine.js');
const AI = require('./ai-light.js');
const { KataGoClient } = require('./neural-ai.js');
const { T } = require('./i18n.js');
const { MCEngine, contextFromRoom, CFG: MC_CFG, setConfig: mcSetConfig, configSummary: mcSummary } = require('./mc.js');
const SETTINGS = require('./settings.js');

const PORT            = process.env.PORT || 3000;
const SUPABASE_URL    = process.env.SUPABASE_URL || '';
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || '';
const DIRECTOR_TOKEN  = process.env.DIRECTOR_TOKEN || 'dev-director';
const DB_ON           = !!(SUPABASE_URL && SUPABASE_KEY);
const AI_DELAY_MS     = Number(process.env.AI_DELAY_MS ?? 600);   // หน่วงให้ AI ดูเหมือนกำลังคิด
const AI_RESULT_HOLD_MS = Number(process.env.AI_RESULT_HOLD_MS ?? 60_000);
const neuralAI = new KataGoClient();

// เสียง MC ใช้ไฟล์ MP3 จาก Google Translate TTS แล้วส่งกลับให้หน้า Live
// เพื่อให้เสียงพูดเข้าช่อง AudioContext เดียวกับเพลง และถูกส่งออกไปพร้อมกัน
const TTS_LANGS = Object.freeze({ th: 'th', en: 'en', ja: 'ja' });
const TTS_MAX_CHARS = 180;
const TTS_CACHE_MAX = 64;
const ttsCache = new Map();

async function getTTS(lang, text) {
  const tl = TTS_LANGS[lang] || TTS_LANGS.th;
  const phrase = String(text || '').trim().slice(0, TTS_MAX_CHARS);
  if (!phrase) throw new Error('empty_tts_text');
  const key = `${tl}:${phrase}`;
  if (ttsCache.has(key)) return ttsCache.get(key);

  const pending = (async () => {
    const endpoint = new URL('https://translate.googleapis.com/translate_tts');
    endpoint.searchParams.set('client', 'gtx');
    endpoint.searchParams.set('sl', 'auto');
    endpoint.searchParams.set('tl', tl);
    endpoint.searchParams.set('dt', 't');
    endpoint.searchParams.set('q', phrase);
    const r = await fetch(endpoint, {
      headers: { 'Accept': 'audio/mpeg', 'User-Agent': 'GoBattleLive/1.0' },
    });
    if (!r.ok) throw new Error(`tts_http_${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('empty_tts_audio');
    return buf;
  })();
  ttsCache.set(key, pending);
  try {
    const buf = await pending;
    while (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(key, buf);
    return buf;
  } catch (e) {
    ttsCache.delete(key);
    throw e;
  }
}

const RECONNECT_GRACE_MS = 60_000;
const TICK_MS            = 250;

const AI_LEVELS = Object.freeze([
  { id: 'firstSteps',      strength: 0.02, gor: -900, rank: '30k', reading: 0,  replyWeight: 0    },
  { id: 'novice',          strength: 0.06, gor: -400, rank: '25k', reading: 0,  replyWeight: 0    },
  { id: 'starter',         strength: 0.12, gor: 100,  rank: '20k', reading: 0,  replyWeight: 0    },
  { id: 'beginner',        strength: 0.20, gor: 600,  rank: '15k', reading: 0,  replyWeight: 0    },
  { id: 'developing',      strength: 0.30, gor: 900,  rank: '12k', reading: 0,  replyWeight: 0    },
  { id: 'foundation',      strength: 0.38, gor: 1100, rank: '10k', reading: 0,  replyWeight: 0    },
  { id: 'club',            strength: 0.47, gor: 1300, rank: '8k',  reading: 0,  replyWeight: 0    },
  { id: 'intermediate',    strength: 0.56, gor: 1600, rank: '5k',  reading: 0,  replyWeight: 0    },
  { id: 'strongKyu',       strength: 0.65, gor: 1800, rank: '3k',  reading: 0,  replyWeight: 0    },
  { id: 'advanced',        strength: 0.72, gor: 2000, rank: '1k',  reading: 0,  replyWeight: 0    },
  { id: 'expert',          strength: 0.80, gor: 2100, rank: '1d',  reading: 1,  replyWeight: 0.10 },
  { id: 'master',          strength: 0.86, gor: 2300, rank: '3d',  reading: 2,  replyWeight: 0.15 },
  { id: 'grandmaster',     strength: 0.90, gor: 2500, rank: '5d',  reading: 3,  replyWeight: 0.25 },
  { id: 'amateurElite',    strength: 0.93, gor: 2700, rank: '7d',  reading: 4,  replyWeight: 0.35 },
  { id: 'amateurChampion', strength: 0.95, gor: 2900, rank: '9d',  reading: 5,  replyWeight: 0.45 },
  { id: 'proEntry',        strength: 0.97, gor: 3100, rank: '1p',  reading: 6,  replyWeight: 0.55 },
  { id: 'pro',             strength: 0.98, gor: 3300, rank: '3p',  reading: 7,  replyWeight: 0.65 },
  { id: 'elitePro',        strength: 0.99, gor: 3600, rank: '6p',  reading: 8,  replyWeight: 0.75 },
  { id: 'worldPro',        strength: 1.00, gor: 3900, rank: '9p',  reading: 10, replyWeight: 0.85 },
  { id: 'neuralMax',       strength: 1.00, gor: 5000, rank: '∞',   reading: 10, replyWeight: 1.00,
    engine: 'neural' },
]);
const AI_LEVEL_BY_ID = new Map(AI_LEVELS.map(level => [level.id, level]));
const LEGACY_AI_LEVEL_IDS = Object.freeze({
  seed15k: 'beginner',
  bamboo10k: 'foundation',
  ping8k: 'club',
});
const AI_HUMAN_NAMES = Object.freeze([
  'นนท์ ธนกฤต', 'มินตรา พิมพ์ใจ', 'ภูริ วรเมธ', 'นารา ชนิกา',
  'ต้นกล้า ภาคิน', 'เมษา ณิชา', 'ธีร์ กฤติน', 'พิม วริศรา',
  'เจ เจษฎา', 'แพรว พิชญา', 'คิม กิตติ', 'โมนา ศิริน',
  'วิน ภูวดล', 'ฟ้า ปาริฉัตร', 'ออม อัญชลี', 'ไนท์ นรินทร์',
  'มีน มนัสวี', 'ปุณณ์ ปัณณวิชญ์', 'เรย์ รวิศ', 'ขิม ขวัญชนก',
]);

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

function seatRankLabel(seat) {
  return seat?.ai?.rank || gorToLabel(seat?.gor);
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
const AUTO_DWELL_MS = Number(process.env.AUTO_DWELL_MS ?? 60_000);   // ห้องที่ยังเล่นอยู่ค้างภาพ 1 นาที
const AUTO_FINISHED_HOLD_MS = Number(process.env.AUTO_FINISHED_HOLD_MS ?? 10_000);

function makeCode() {
  let c;
  do { c = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function randomAIPlayerNames() {
  const first = Math.floor(Math.random() * AI_HUMAN_NAMES.length);
  let second = Math.floor(Math.random() * (AI_HUMAN_NAMES.length - 1));
  if (second >= first) second += 1;
  return [AI_HUMAN_NAMES[first], AI_HUMAN_NAMES[second]];
}

function makeAISeat(level, name) {
  const engine = level.engine || 'heuristic';
  const ai = {
    id: `catalog-${level.id}`,
    levelId: level.id,
    rank: level.rank,
    strength: level.strength,
    reading: level.reading,
    replyWeight: level.replyWeight,
    engine,
    engineStatus: engine === 'neural' ? 'ready' : 'local',
  };
  return { userId: null, name, gor: level.gor, ws: null, ai };
}

function aiLevelAvailable(level) {
  return level.engine !== 'neural' || neuralAI.configured;
}

function aiCatalog() {
  return AI_LEVELS.map(({ id, rank, engine = 'heuristic' }) => ({
    id,
    rank,
    engine,
    available: engine !== 'neural' || neuralAI.configured,
  }));
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
    mode: opts.mode === 'ai_vs_ai' ? 'ai_vs_ai' : (opts.vsAI ? 'human_vs_ai' : 'human'),
    score: null,
    finishedAt: null,
    autoCloseAt: null,
    closeTimer: null,
    aiThinking: null,
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

// ส่งข้อผิดพลาดเป็น "รหัส" เพื่อให้หน้าเว็บแปลเป็นภาษาที่ผู้ใช้เลือกเอง
// แนบข้อความไทยไปด้วยสำหรับไคลเอนต์เก่าและสำหรับดู log
function sendErr(ws, code) {
  send(ws, { t: 'error', code, msg: T('srv.' + code, null, 'th') });
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
  const player = seat => seat && {
    name: seat.name,
    rank: seatRankLabel(seat),
    ai: !!seat.ai,
    aiLevel: seat.ai?.levelId || null,
    aiEngine: seat.ai?.engine || null,
    aiEngineStatus: seat.ai?.engineStatus || null,
    online: seat.ai ? true : !!seat.ws,
  };
  return {
    code: room.code,
    state: room.state,
    game: room.game.snapshot(),
    players: {
      black: player(room.seats[BLACK]),
      white: player(room.seats[WHITE]),
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
    mode: room.mode,
    result: room.game.result || null,
    score: room.score || room.game.result?.score || null,
    autoCloseAt: room.autoCloseAt,
  };
}

function pushState(room) { broadcast(room, { t: 'state', ...publicState(room) }); }

/* =====================================================================
 * ระบบ MC พากย์อัตโนมัติ — พูดตลอดเวลาบนภาพออกอากาศ
 * ใช้ Groq ก่อน ถ้าไม่ได้ลอง OpenRouter ถ้ายังไม่ได้ใช้คำพากย์สำเร็จรูป
 * จึงไม่มีทางเงียบ แม้ไม่ได้ใส่คีย์ AI เลย
 * ===================================================================== */
const mc = new MCEngine();
let mcAuto = true;
let mcEpoch = 0;                    // ยกเลิกคำพากย์ที่ยังรอ AI เมื่อปิด MC
let lastCutscene = -1;

function autoCutscene(kind) {
  if (!['capture', 'byoyomi', 'end'].includes(kind)) return;
  const ready = SETTINGS.manifest().cutscenes.filter(c => c.image);
  if (!ready.length) return;
  lastCutscene = (lastCutscene + 1) % ready.length;
  const scene = ready[lastCutscene];
  for (const v of liveViewers) send(v, { t: 'custom_cutscene', id: scene.id,
    imageUrl: scene.image.url, audioUrl: scene.audio?.url || null });
}

async function mcSpeak(kind = 'idle', extra = {}, force = false) {
  if (!mcAuto || liveViewers.size === 0) return false;
  if (!mc.ready(Date.now(), force)) return false;
  const epoch = mcEpoch;
  const room = programRoom && rooms.get(programRoom);
  const ctx = room
    ? contextFromRoom(room, {
        blackRank: seatRankLabel(room.seats[BLACK]),
        whiteRank: seatRankLabel(room.seats[WHITE]),
        ...extra,
      })
    : { size: 9, komi: 1.5, moveCount: 0, turn: BLACK, capB: 0, capW: 0,
        blackName: '—', whiteName: '—', blackRank: '—', whiteRank: '—', ...extra };
  try {
    const r = await mc.say(ctx, kind);
    // ผู้กำกับอาจปิด MC ระหว่างที่รอ Groq/OpenRouter ตอบกลับ
    if (!mcAuto || epoch !== mcEpoch) return false;
    for (const v of liveViewers) send(v, { t: 'mc', text: r.text, lang: r.lang, source: r.source, kind });
    autoCutscene(kind);
    return true;
  } catch (e) {
    console.warn('[mc]', e.message);
    return false;
  }
}

// ไฟล์เสียงเปลี่ยน -> บอกทุกเครื่องให้โหลดใหม่เงียบ ๆ
function broadcastManifest() {
  const msg = JSON.stringify({ t: 'manifest', ...SETTINGS.manifest() });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

// ตั้งห้องที่ออกอากาศ ส่ง null = จอดำ
function setProgram(code, transition = 'ink') {
  programRoom = code;
  for (const d of directors)   send(d, { t: 'program', code: programRoom, auto: autoProgram });
  for (const v of liveViewers) send(v, { t: 'program', code: programRoom, transition, auto: autoProgram });
  const room = code && rooms.get(code);
  if (room) {
    for (const v of liveViewers) send(v, { t: 'state', ...publicState(room) });
    pushState(room);
    mcSpeak('start', { event: 'the broadcast just switched to this room' }, true);
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

function closeRoom(room, reason = 'closed') {
  if (!room || !rooms.has(room.code)) return false;
  if (room.closeTimer) clearTimeout(room.closeTimer);
  room.aiThinking = null;
  room.state = 'closed';
  room.turnStartedAt = null;
  const payload = { t: 'room_closed', code: room.code, reason };
  for (const c of [BLACK, WHITE]) {
    const client = room.seats[c]?.ws;
    if (client) {
      send(client, payload);
      if (client.room === room.code) client.room = null;
    }
  }
  for (const spectator of room.spectators) {
    send(spectator, payload);
    if (spectator.room === room.code) spectator.room = null;
  }
  for (const director of directors) send(director, payload);
  if (programRoom === room.code) {
    for (const viewer of liveViewers) send(viewer, payload);
  }
  rooms.delete(room.code);
  if (programRoom === room.code) setProgram(null, 'fade');
  return true;
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
  room.score = extra.score || result.score || null;
  room.finishedAt = Date.now();
  room.turnStartedAt = null;
  if (room.mode === 'ai_vs_ai') {
    room.autoCloseAt = Date.now() + AI_RESULT_HOLD_MS;
    room.closeTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && room.state === 'finished') closeRoom(room, 'ai_result_complete');
    }, AI_RESULT_HOLD_MS);
    room.closeTimer.unref?.();
  }
  broadcast(room, { t: 'end', result, ...extra, ...publicState(room) });
  broadcast(room, { t: 'sfx', id: 'game_end' });
  if (programRoom === room.code) mcSpeak('end', { event: 'the game just finished: ' + result.text }, true);
  if (room.mode !== 'ai_vs_ai') {
    saveGame(room, result).catch(e => console.error('[save]', e.message));
  }
}

function timeoutLoss(room) {
  const loser = room.game.turn;
  endGame(room, {
    type: loser === BLACK ? 'white_win' : 'black_win',
    text: loser === BLACK ? 'W+T' : 'B+T',
    reason: 'หมดเวลา', reasonCode: 'timeout',
  });
}

function doPlay(room, color, x, y) {
  if (room.state !== 'playing') return { error: 'not_started' };
  if (room.game.turn !== color) return { error: 'not_your_turn' };
  if (applyElapsed(room)) { timeoutLoss(room); return { handled: true }; }

  const r = room.game.play(x, y, color);
  if (!r.ok) { room.turnStartedAt = Date.now(); return { error: r.error }; }

  updateHeat(room, r.captured.length);
  broadcast(room, { t: 'sfx', id: r.captured.length ? 'capture' : 'stone' });
  if (programRoom === room.code) {
    mcSpeak(r.captured.length ? 'capture' : 'move',
            r.captured.length ? { lastCapture: r.captured.length } : {},
            r.captured.length >= 3);
  }

  if (r.noResult) {
    endGame(room, { type: 'no_result', text: 'No result', reason: 'ตำแหน่งซ้ำ (ซันโคะ)', reasonCode: 'repeat' });
    return { handled: true };
  }
  pushState(room);
  maybeAIMove(room);
  return { handled: true };
}

function doPass(room, color) {
  if (room.state !== 'playing') return { error: 'not_started' };
  if (room.game.turn !== color) return { error: 'not_your_turn' };
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

async function chooseAIMove(room, color, seat) {
  if (seat.ai.engine !== 'neural') return AI.chooseMove(room.game, color, seat.ai);

  seat.ai.engineStatus = 'thinking';
  pushState(room);
  try {
    const move = await neuralAI.chooseMove(room.game, color, seat.ai);
    seat.ai.engineStatus = 'online';
    seat.ai.lastNeuralError = null;
    return move;
  } catch (error) {
    // เกมต้องไม่ค้างหาก GPU service หลุดระหว่างเล่น แต่หน้าคอนโทรลจะเห็น
    // สถานะ FALLBACK ชัดเจน จึงไม่แอบอ้างว่าเป็นตาจาก neural network
    seat.ai.engineStatus = 'fallback';
    const message = String(error?.message || error);
    const now = Date.now();
    if (seat.ai.lastNeuralError !== message || now - (seat.ai.lastNeuralWarningAt || 0) > 30_000) {
      console.warn(`[neural-ai] ${room.code} ${color === BLACK ? 'B' : 'W'}: ${message}`);
      seat.ai.lastNeuralError = message;
      seat.ai.lastNeuralWarningAt = now;
    }
    return AI.chooseMove(room.game, color, seat.ai);
  }
}

function maybeAIMove(room) {
  if (room.state !== 'playing') return;
  const c = room.game.turn;
  const seat = room.seats[c];
  if (!seat?.ai) return;
  if (room.aiThinking) return;
  const token = { color: c, moveCount: room.game.history.length };
  room.aiThinking = token;
  const delay = AI_DELAY_MS + Math.random() * AI_DELAY_MS * 2;   // ให้ดูเหมือนกำลังคิด
  setTimeout(async () => {
    if (room.aiThinking !== token || room.state !== 'playing' || room.game.turn !== c) {
      if (room.aiThinking === token) room.aiThinking = null;
      return;
    }
    const mv = await chooseAIMove(room, c, seat);
    if (room.aiThinking !== token || room.state !== 'playing' || room.game.turn !== c ||
        room.game.history.length !== token.moveCount) {
      if (room.aiThinking === token) room.aiThinking = null;
      return;
    }
    room.aiThinking = null;
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
      blackRank: seatRankLabel(b), whiteRank: seatRankLabel(w),
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
function nextRoomInOrder(list, currentCode) {
  if (!list.length) return null;
  const currentIndex = list.findIndex(room => room.code === currentCode);
  const start = currentIndex >= 0 ? currentIndex : -1;
  for (let offset = 1; offset <= list.length; offset++) {
    const room = list[(start + offset) % list.length];
    if (room.code !== currentCode) return room;
  }
  return null;
}

function autoPickRoom() {
  if (!autoProgram) return;
  const now = Date.now();
  const cur = programRoom && rooms.get(programRoom);

  if (cur?.state === 'finished') {
    // เกมจบแล้วให้ผู้ชมเห็นผลบนจอ 10 วินาที แล้วจึงเปลี่ยนห้อง
    const finishedAt = cur.finishedAt || lastAutoSwitch;
    if (now - finishedAt < AUTO_FINISHED_HOLD_MS) return;
  } else if (cur && now - lastAutoSwitch < AUTO_DWELL_MS) {
    // เกมที่ยังเล่นอยู่ค้างภาพอย่างน้อย 1 นาที
    return;
  }

  const all = [...rooms.values()];
  const playing = all.filter(room => room.state === 'playing');
  const waiting = all.filter(room =>
    room.state === 'waiting' || room.state === 'ready' || room.state === 'marking');

  let pool;
  if (!cur || cur.state === 'finished') {
    pool = playing.length ? playing : waiting;
  } else {
    // ให้ห้องที่กำลังเล่นมีความสำคัญก่อน แต่ถ้าไม่มีห้องเล่นอื่นแล้ว
    // ให้หมุนไปห้องรอ/ห้องกำลังสรุปแทน เพื่อไม่ค้างภาพเดิมตลอด
    const otherPlaying = playing.some(room => room.code !== cur.code);
    pool = otherPlaying ? playing : waiting.filter(room => room.code !== cur.code);
  }

  const pick = nextRoomInOrder(pool, cur?.code);
  if (!pick) {
    // ไม่มีห้องอื่นให้หมุนไป ถ้าห้องปัจจุบันจบแล้วจึงค่อยตัดเป็นจอดำ
    if (cur?.state === 'finished' && programRoom) {
      lastAutoSwitch = now;
      setProgram(null, 'fade');
    }
    return;
  }
  lastAutoSwitch = now;
  setProgram(pick.code, 'ink');
}

/* =====================================================================
 * ส่วนที่ 5 — ตัวจับเวลาหลัก
 * ===================================================================== */
setInterval(() => {
  const now = Date.now();
  autoPickRoom();
  if (mcAuto && liveViewers.size && mc.idle(now)) {
    const r = programRoom && rooms.get(programRoom);
    // No selected room means an invitation screen, never commentary about an old match.
    mcSpeak(r && r.state === 'playing' ? 'idle' : (r ? 'idle' : 'invite'));
  }
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
          reason: 'ผู้เล่นหลุดเกินเวลาที่กำหนด', reasonCode: 'forfeit',
        });
      }
    }
    // เก็บกวาดห้องร้าง
    if (room.mode !== 'ai_vs_ai' && everyone(room).length === 0 && now - room.createdAt > 10 * 60_000) {
      closeRoom(room, 'abandoned');
    }
  }
}, TICK_MS);

/* =====================================================================
 * ส่วนที่ 6 — HTTP + WebSocket
 * ===================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > maxBytes) { reject(new Error('ไฟล์ใหญ่เกินกำหนด')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const isDirector = req => (req.headers['x-director-token'] || '') === DIRECTOR_TOKEN;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  /* ---------- เสียง MC เป็น MP3 เพื่อเข้า AudioContext ของหน้า Live ---------- */
  if (url.pathname === '/api/tts' && req.method === 'GET') {
    const lang = url.searchParams.get('lang') || 'th';
    const text = (url.searchParams.get('text') || '').trim();
    if (!TTS_LANGS[lang] || !text || text.length > TTS_MAX_CHARS) {
      return json(res, 400, { error: 'invalid_tts_request' });
    }
    try {
      const audio = await getTTS(lang, text);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(audio);
    } catch (e) {
      console.warn('[tts]', e.message);
      return json(res, 502, { error: 'tts_unavailable' });
    }
  }

  /* ---------- รายการไฟล์เสียงสำหรับโหลดล่วงหน้า (เปิดสาธารณะ) ---------- */
  if (url.pathname === '/api/manifest') return json(res, 200, SETTINGS.manifest());

  /* ---------- ไฟล์เสียงในหน่วยความจำ (ใช้เมื่อไม่ได้ตั้ง Supabase) ---------- */
  if (url.pathname.startsWith('/api/audio/') && req.method === 'GET') {
    const slot = url.pathname.split('/')[3];
    const f = SETTINGS.getMemoryFile(slot);
    if (!f) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'no-cache' });
    return res.end(f.buf);
  }

  /* ---------- หน้าตั้งค่าของผู้กำกับ ---------- */
  if (url.pathname === '/api/settings') {
    if (!isDirector(req)) return json(res, 403, { error: 'no_permission' });
    if (req.method === 'GET') {
      return json(res, 200, {
        mc: mcSummary(),
        audio: SETTINGS.manifest(),
        slots: SETTINGS.SLOTS,
        audioTypes: SETTINGS.AUDIO_TYPES,
        imageTypes: SETTINGS.IMAGE_TYPES,
        storage: SETTINGS.DB_ON ? 'supabase' : 'memory',
      });
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        const patch = {};
        for (const k of ['groqKey', 'orKey', 'groqModel', 'orModel', 'lang', 'minGapMs', 'idleMs'])
          if (body[k] !== undefined && body[k] !== '') patch[k] = body[k];
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (patch.minGapMs) patch.minGapMs = Number(patch.minGapMs);
        if (patch.idleMs)   patch.idleMs   = Number(patch.idleMs);
        await SETTINGS.saveMC(patch);
        mcSetConfig(patch);
        if (patch.lang) mc.setLang(patch.lang);
        return json(res, 200, { ok: true, mc: mcSummary() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
  }

  /* ---------- อัปโหลด / ลบไฟล์เสียง ---------- */
  if (url.pathname.startsWith('/api/audio/') && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!isDirector(req)) return json(res, 403, { error: 'no_permission' });
    const slot = url.pathname.split('/')[3];
    if (!SETTINGS.SLOT_IDS.includes(slot)) return json(res, 400, { error: 'ไม่รู้จักช่องเสียงนี้' });
    try {
      if (req.method === 'DELETE') {
        await SETTINGS.removeAudio(slot);
      } else {
        const buf = await readBody(req, 10 * 1024 * 1024);
        await SETTINGS.uploadAudio(slot, buf, req.headers['content-type'],
                                   decodeURIComponent(req.headers['x-file-name'] || ''));
      }
      broadcastManifest();
      return json(res, 200, { ok: true, audio: SETTINGS.manifest() });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  /* ---------- ภาพและเสียงคัตซีนกำหนดเอง 10 ช่อง ---------- */
  const cutMatch = url.pathname.match(/^\/api\/cutscenes\/(\d+)\/(image|audio)$/);
  if (cutMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!isDirector(req)) return json(res, 403, { error: 'no_permission' });
    try {
      const [, index, kind] = cutMatch;
      if (req.method === 'DELETE') await SETTINGS.removeCutscene(index, kind);
      else {
        const buf = await readBody(req, 6 * 1024 * 1024);
        await SETTINGS.uploadCutscene(index, kind, buf, req.headers['content-type'],
          decodeURIComponent(req.headers['x-file-name'] || ''));
      }
      broadcastManifest();
      return json(res, 200, { ok: true, manifest: SETTINGS.manifest() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/api/rooms') {
    const list = [...rooms.values()].map(r => ({
      code: r.code, state: r.state, size: r.game.size,
      moves: r.game.history.length, heat: r.heat,
      black: r.seats[BLACK]?.name ?? null, white: r.seats[WHITE]?.name ?? null,
      blackAI: !!r.seats[BLACK]?.ai, whiteAI: !!r.seats[WHITE]?.ai,
      blackAILevel: r.seats[BLACK]?.ai?.levelId ?? null,
      whiteAILevel: r.seats[WHITE]?.ai?.levelId ?? null,
      blackAIEngine: r.seats[BLACK]?.ai?.engine ?? null,
      whiteAIEngine: r.seats[WHITE]?.ai?.engine ?? null,
      blackAIEngineStatus: r.seats[BLACK]?.ai?.engineStatus ?? null,
      whiteAIEngineStatus: r.seats[WHITE]?.ai?.engineStatus ?? null,
      mode: r.mode, autoCloseAt: r.autoCloseAt,
      onAir: programRoom === r.code,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ rooms: list, program: programRoom }));
  }
  // เอนจินโกะใช้ร่วมกันระหว่างเซิร์ฟเวอร์กับเบราว์เซอร์ (ตรวจตาผิดกติกาได้ทันทีฝั่งผู้เล่น)
  if (url.pathname === '/i18n.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'i18n.js')));
  }
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
    catch (e) { console.error('[handle]', e); sendErr(ws, 'internal'); }
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
      send(ws, {
        t: 'welcome',
        playerToken: identity.token,
        name: identity.name,
        guest: identity.guest,
        dbOn: DB_ON,
        aiLevels: aiCatalog(),
        neural: neuralAI.publicStatus(),
      });
      send(ws, { t: 'manifest', ...SETTINGS.manifest() });
      return;
    }

    /* ---- สร้างห้อง ---- */
    case 'create': {
      if (!ws.identity) return sendErr(ws, 'not_authed');
      let selectedAILevel = null;
      if (m.vsAI) {
        const requested = String(m.aiLevel || m.ai?.levelId || m.ai?.id || '');
        const levelId = LEGACY_AI_LEVEL_IDS[requested] || requested;
        selectedAILevel = AI_LEVEL_BY_ID.get(levelId) || AI_LEVEL_BY_ID.get('foundation');
        if (!aiLevelAvailable(selectedAILevel)) return sendErr(ws, 'neural_unavailable');
      }
      const room = createRoom(m);
      const color = m.color === 'W' ? WHITE : BLACK;
      let gor = 100;
      if (ws.identity.userId) gor = (await loadRating(ws.identity.userId, room.game.size))?.gor ?? 100;
      room.seats[color] = { ...ws.identity, gor, ws };
      ws.room = room.code;

      if (m.vsAI) {
        const [name] = randomAIPlayerNames();
        const other = color === BLACK ? WHITE : BLACK;
        room.seats[other] = makeAISeat(selectedAILevel, name);
        room.ready[other] = true;
      }
      send(ws, { t: 'joined', code: room.code, color: color === BLACK ? 'B' : 'W' });
      pushState(room);
      return;
    }

    /* ---- เข้าห้อง / กลับเข้าห้องหลังหลุด ---- */
    case 'join': {
      if (!ws.identity) return sendErr(ws, 'not_authed');
      const room = rooms.get((m.code || '').toUpperCase());
      if (!room) return sendErr(ws, 'no_room');

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
      const c = seatOf(room, ws); if (!c) return sendErr(ws, 'spectator');
      const r = doPlay(room, c, m.x | 0, m.y | 0);
      if (r.error) sendErr(ws, r.error);
      return;
    }

    case 'pass': {
      const room = rooms.get(ws.room); if (!room) return;
      const c = seatOf(room, ws); if (!c) return;
      const r = doPass(room, c);
      if (r.error) sendErr(ws, r.error);
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
      if (m.token !== DIRECTOR_TOKEN) return sendErr(ws, 'bad_director_token');
      directors.add(ws);
      send(ws, {
        t: 'director_ok',
        program: programRoom,
        aiLevels: aiCatalog(),
        neural: neuralAI.publicStatus(),
      });
      return;
    }

    /* ---- ผู้กำกับสร้างเกม AI ปะทะ AI และเริ่มทันที ---- */
    case 'director_create_ai_game': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      const blackLevel = AI_LEVEL_BY_ID.get(String(m.blackLevel || 'intermediate'))
        || AI_LEVEL_BY_ID.get('intermediate');
      const whiteLevel = AI_LEVEL_BY_ID.get(String(m.whiteLevel || 'intermediate'))
        || AI_LEVEL_BY_ID.get('intermediate');
      if (!aiLevelAvailable(blackLevel) || !aiLevelAvailable(whiteLevel)) {
        return sendErr(ws, 'neural_unavailable');
      }
      const size = [9, 13, 19].includes(Number(m.size)) ? Number(m.size) : 9;
      const [blackName, whiteName] = randomAIPlayerNames();
      const room = createRoom({
        size,
        mode: 'ai_vs_ai',
        timeRule: { main: 0, byoyomi: 30, periods: 3 },
      });
      room.seats[BLACK] = makeAISeat(blackLevel, blackName);
      room.seats[WHITE] = makeAISeat(whiteLevel, whiteName);
      room.ready[BLACK] = true;
      room.ready[WHITE] = true;
      tryStart(room);
      send(ws, { t: 'ai_game_created', ...publicState(room) });
      return;
    }

    /* ---- ผู้กำกับบังคับปิดห้องที่ค้างหรือมีปัญหา ---- */
    case 'director_close_room': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return sendErr(ws, 'no_room');
      closeRoom(room, 'director');
      return;
    }

    /* ---- หน้าออกอากาศ: รับภาพของห้องที่กำลังออกอากาศเท่านั้น ---- */
    case 'live': {
      liveViewers.add(ws);
      // โหมดอัตโนมัติ: ใช้ตอนถ่ายทอดด้วยมือถือเครื่องเดียว ไม่มีคนคุมหน้าเบื้องหลัง
      if (m.auto && !autoProgram) {
        autoProgram = true;
        lastAutoSwitch = programRoom ? Date.now() : 0;
        autoPickRoom();
      }
      if (m.lang) mc.setLang(m.lang);
      send(ws, { t: 'program', code: programRoom, auto: autoProgram });
      send(ws, { t: 'mc_info', lang: mc.lang, auto: mcAuto, hasAI: mc.hasAI });
      const room = programRoom && rooms.get(programRoom);
      if (room) send(ws, { t: 'state', ...publicState(room) });
      mcSpeak(room ? 'idle' : 'invite', {}, true);
      return;
    }

    /* ---- ผู้กำกับขอรับภาพหลายห้องพร้อมกัน (ไม่นั่งเป็นผู้เล่น) ---- */
    case 'watch': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
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
      if (!room) return sendErr(ws, 'no_room');
      const prev = ws.room && rooms.get(ws.room);
      if (prev) prev.spectators.delete(ws);
      room.spectators.add(ws); ws.room = room.code;
      send(ws, { t: 'joined', code: room.code, color: null, spectator: true });
      send(ws, { t: 'state', ...publicState(room) });
      return;
    }

    /* ---- ผู้กำกับยิงคัตซีนค่ายกล / ข้อความ MC ขึ้นภาพออกอากาศ ---- */
    case 'highlight': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      const payload = {
        t: 'highlight',
        nameTh: String(m.nameTh || 'ค่ายกล').slice(0, 40),
        nameJa: String(m.nameJa || '').slice(0, 40),
        tier: ['R', 'SR', 'SSR'].includes(m.tier) ? m.tier : 'SR',
        coords: Array.isArray(m.coords) ? m.coords.slice(0, 40) : [],
      };
      for (const v of liveViewers) send(v, payload);
      mcSpeak('cut', { pattern: payload.nameTh + (payload.nameJa ? ' / ' + payload.nameJa : '') }, true);
      return;
    }

    case 'mc': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      const payload = { t: 'mc', text: String(m.text || '').slice(0, 200) };
      for (const v of liveViewers) send(v, payload);
      return;
    }

    case 'mc_lang': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      mc.setLang(m.lang);
      for (const d of directors) send(d, { t: 'mc_lang', lang: mc.lang });
      for (const v of liveViewers) send(v, { t: 'mc_info', lang: mc.lang, auto: mcAuto, hasAI: mc.hasAI });
      mcSpeak('idle', {}, true);
      return;
    }

    case 'mc_auto': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      mcAuto = m.value !== false;
      mcEpoch++;
      for (const d of directors) send(d, { t: 'mc_auto', value: mcAuto, hasAI: mc.hasAI });
      for (const v of liveViewers) {
        send(v, { t: 'mc_info', lang: mc.lang, auto: mcAuto, hasAI: mc.hasAI });
        if (!mcAuto) send(v, { t: 'mc_stop' });
      }
      // เปิดกลับมาแล้วให้มีประโยคใหม่ทันที ไม่ต้องรอรอบ idle ถัดไป
      if (mcAuto) {
        mcSpeak('idle', {}, true).then(spoken => {
          if (!spoken && mcAuto) setTimeout(() => mcSpeak('idle', {}, true), MC_CFG.timeoutMs + 100);
        });
      }
      return;
    }

    case 'auto': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      autoProgram = m.value !== false;
      // ถ้ามีภาพอยู่แล้ว ให้เริ่มนับหนึ่งนาทีจากภาพปัจจุบัน;
      // ถ้ายังไม่มีภาพ ให้เลือกห้องแรกขึ้นมาทันที
      lastAutoSwitch = autoProgram && programRoom ? Date.now() : 0;
      autoPickRoom();
      for (const d of directors) send(d, { t: 'auto', value: autoProgram });
      return;
    }

    case 'program': {
      if (!directors.has(ws)) return sendErr(ws, 'no_permission');
      autoProgram = false;        // ผู้กำกับสั่งเอง = ปิดโหมดอัตโนมัติ
      if (!m.code) { setProgram(null, m.transition || 'fade'); return; }   // จอดำ
      const room = rooms.get(String(m.code).toUpperCase());
      if (!room) return sendErr(ws, 'no_room');
      setProgram(room.code, m.transition || 'ink');
      return;
    }

    default:
      sendErr(ws, 'bad_command');
  }
}

let bootPromise = null;
function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await SETTINGS.load();
      mcSetConfig(SETTINGS.state.mc);
      if (SETTINGS.state.mc.lang) mc.setLang(SETTINGS.state.mc.lang);
      const n = Object.keys(SETTINGS.state.audio).length;
      console.log(`การตั้งค่า: ${SETTINGS.DB_ON ? 'อ่านจาก Supabase' : 'โหมดหน่วยความจำ'} · ไฟล์เสียง ${n} ช่อง`
                + ` · MC ${mcSummary().groqKeySet ? 'Groq' : mcSummary().orKeySet ? 'OpenRouter' : 'คำพากย์สำรอง'}`);
    })();
  }
  return bootPromise;
}

// Vercel imports the HTTP server as a handler instead of necessarily launching
// this file as the main module, so initialize persisted settings in both modes.
const ready = boot();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Go Battle Live — พร้อมใช้งานที่พอร์ต ${PORT}`);
    console.log(`ฐานข้อมูล Supabase: ${DB_ON ? 'เชื่อมต่อแล้ว' : 'ยังไม่ได้ตั้งค่า (โหมดทดสอบในเครื่อง)'}`);
    const neural = neuralAI.publicStatus();
    console.log(`KataGo Neural: ${neural.configured ? `ตั้งค่าแล้ว (${neural.transport})` : 'ยังไม่ได้ตั้งค่า'}`);
  });
}

// Export the http.Server itself for Vercel's WebSocket runtime, while retaining
// the named properties used by the test suite and other CommonJS consumers.
Object.assign(server, {
  server, rooms, createRoom, newClock, consume, remainingMs, gorToLabel, boot,
  ready, AI_LEVELS, aiCatalog, neuralAI, closeRoom, endGame,
});
module.exports = server;
