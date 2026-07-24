/* =====================================================================
 * GO BATTLE LIVE — mc.js  v1.0
 * ระบบพากย์อัตโนมัติสำหรับการถ่ายทอดสด
 *
 * ลำดับการทำงาน:
 *   1) เรียก Groq  (เร็วและฟรีในโควตาหนึ่ง)
 *   2) ถ้าไม่ได้ ลอง OpenRouter
 *   3) ถ้ายังไม่ได้อีก ใช้คำพากย์สำเร็จรูปที่เขียนไว้ วนใช้แบบไม่ซ้ำติดกัน
 *
 * ออกแบบให้ "ไม่มีวันเงียบ" — ต่อให้ไม่ได้ใส่คีย์ AI เลย MC ก็ยังพูดตลอด
 *
 * ตัวแปรสภาพแวดล้อม:
 *   GROQ_API_KEY        คีย์ Groq
 *   OPENROUTER_API_KEY  คีย์ OpenRouter
 *   MC_MODEL_GROQ       ค่าเริ่มต้น llama-3.3-70b-versatile
 *   MC_MODEL_OPENROUTER ค่าเริ่มต้น meta-llama/llama-3.3-70b-instruct
 *   MC_LANG             th | en | ja   (ค่าเริ่มต้น th)
 *   MC_MIN_GAP_MS       เว้นระยะระหว่างประโยคอย่างน้อยกี่มิลลิวินาที (ค่าเริ่มต้น 7000)
 *   MC_IDLE_MS          ถ้าเงียบเกินเท่านี้ ให้พูดแทรกเอง (ค่าเริ่มต้น 12000)
 *   MC_ENABLED          false เพื่อปิดทั้งระบบ
 * ===================================================================== */

const { T } = require('./i18n.js');

const CFG = {
  groqKey:  process.env.GROQ_API_KEY || '',
  orKey:    process.env.OPENROUTER_API_KEY || '',
  groqModel: process.env.MC_MODEL_GROQ || 'llama-3.3-70b-versatile',
  orModel:   process.env.MC_MODEL_OPENROUTER || 'meta-llama/llama-3.3-70b-instruct',
  lang:      process.env.MC_LANG || 'th',
  minGapMs:  Number(process.env.MC_MIN_GAP_MS ?? 7000),
  idleMs:    Number(process.env.MC_IDLE_MS ?? 12000),
  enabled:   process.env.MC_ENABLED !== 'false',
  timeoutMs: Number(process.env.MC_TIMEOUT_MS ?? 4000),
};

/* =====================================================================
 * คำพากย์สำเร็จรูป — ใช้เมื่อ AI ใช้ไม่ได้
 * เขียนให้พูดวนได้โดยไม่น่าเบื่อ และไม่อ้างสถานการณ์ที่อาจไม่จริง
 * ===================================================================== */
const CANNED = {
  th: {
    idle: [
      'บรรยากาศกำลังตึงเครียดขึ้นเรื่อย ๆ ครับ',
      'ทั้งสองฝ่ายกำลังชั่งใจกันอยู่ครับ',
      'มาดูกันว่าใครจะลงมือก่อน',
      'กระดานเริ่มแน่นขึ้นแล้วครับ',
      'จังหวะนี้สำคัญมากเลยครับ',
      'ใครเผลอก่อน คนนั้นเสียเปรียบทันที',
      'เกมนี้ยังบอกไม่ได้เลยว่าใครได้เปรียบ',
      'อย่ากะพริบตานะครับ',
    ],
    move:    ['ลงตรงนั้นน่าสนใจครับ', 'หมากตานี้คิดมาดีเลย', 'ขยับเข้ามาใกล้แล้วครับ', 'วางได้สวยมากครับตานี้'],
    capture: ['จับกินได้แล้วครับ!', 'หมู่นั้นหลุดไปแล้ว!', 'เก็บไปเรียบร้อยครับ!', 'เสียหมากไปแล้วครับฝ่ายนั้น!'],
    start:   ['เริ่มแล้วครับ ขอให้สนุกกับการชมนะครับ', 'มาแล้วครับ ศึกกระดานหมากล้อม'],
    byoyomi: ['เข้าเบียวโยมิแล้วครับ เวลาเหลือน้อยมาก', 'เวลาบีบแล้วครับ ต้องรีบตัดสินใจ'],
    end:     ['จบเกมแล้วครับ ขอบคุณที่ติดตามชม', 'สนุกมากครับเกมนี้'],
    cut:     ['โอ้โห ตานี้คือค่ายกลของแท้ครับ!', 'สวยมากครับ! ตานี้คือของจริง!'],
  },
  en: {
    idle: [
      'The tension keeps building here.',
      'Both players are weighing their options.',
      'Let us see who commits first.',
      'The board is filling up nicely.',
      'This is a critical stretch.',
      'One slip here and the game turns.',
      'Still far too close to call.',
      'Do not look away now.',
    ],
    move:    ['Interesting placement there.', 'That move looks well considered.', 'They are closing the distance.', 'A nice shape forming.'],
    capture: ['And a capture!', 'That group is gone!', 'Stones come off the board!', 'A costly loss right there!'],
    start:   ['Here we go, welcome to the broadcast.', 'The battle on the board begins.'],
    byoyomi: ['Into byo-yomi now, very little time left.', 'The clock is squeezing them.'],
    end:     ['That is the game. Thanks for watching.', 'What a match that was.'],
    cut:     ['Oh, that is a genuine tesuji!', 'Beautiful! That is the real thing!'],
  },
  ja: {
    idle: [
      '緊張感が高まってきました。',
      '両者とも慎重に読んでいます。',
      'どちらが先に動くでしょうか。',
      '盤面が込み合ってきました。',
      'ここが大事な場面です。',
      '一手のミスが勝負を分けます。',
      'まだ形勢は分かりません。',
      '目が離せません。',
    ],
    move:    ['面白いところに打ちました。', 'よく考えられた一手です。', '距離を詰めてきました。', 'いい形になってきました。'],
    capture: ['取りました！', 'あの一団が落ちました！', '石が上がりました！', '大きな損害です！'],
    start:   ['さあ始まりました。ご覧ください。', '盤上の戦いの始まりです。'],
    byoyomi: ['秒読みに入りました。時間がありません。', '時間に追われています。'],
    end:     ['終局です。ご覧いただきありがとうございました。', '見応えのある一局でした。'],
    cut:     ['おお、これは本物の手筋です！', '見事！これぞ実戦の妙手！'],
  },
};

/* =====================================================================
 * ตัวช่วย
 * ===================================================================== */
function pickCanned(lang, kind, avoid) {
  const bank = (CANNED[lang] || CANNED.th)[kind] || (CANNED[lang] || CANNED.th).idle;
  if (bank.length === 1) return bank[0];
  let s, guard = 0;
  do { s = bank[Math.floor(Math.random() * bank.length)]; } while (s === avoid && ++guard < 8);
  return s;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

const LANG_NAME = { th: 'Thai', en: 'English', ja: 'Japanese' };

function systemPrompt(lang) {
  return [
    'You are a live commentator for an online Go (baduk/weiqi) match streamed on TikTok.',
    `Reply ONLY in ${LANG_NAME[lang] || 'Thai'}.`,
    'Give exactly ONE spoken sentence, at most 20 words, suitable for text-to-speech.',
    'Be energetic but never invent facts that are not in the given state.',
    'No emoji, no markdown, no quotation marks, no move coordinates unless given.',
    'Do not repeat the previous line you are shown.',
  ].join(' ');
}

function describeState(ctx, lang) {
  const L = [];
  L.push(`Board ${ctx.size}x${ctx.size}, komi ${ctx.komi}.`);
  L.push(`Black: ${ctx.blackName} (${ctx.blackRank}). White: ${ctx.whiteName} (${ctx.whiteRank}).`);
  L.push(`Move ${ctx.moveCount}, ${ctx.turn === 1 ? 'Black' : 'White'} to play.`);
  L.push(`Captures — black ${ctx.capB}, white ${ctx.capW}.`);
  if (ctx.lastCapture) L.push(`A group of ${ctx.lastCapture} stones was just captured.`);
  if (ctx.ko) L.push('There is an active ko.');
  if (ctx.byoyomi) L.push('A player is in byo-yomi with very little time.');
  if (ctx.event) L.push(`Event: ${ctx.event}.`);
  if (ctx.pattern) L.push(`A tesuji just appeared: ${ctx.pattern}.`);
  if (ctx.previous) L.push(`Your previous line was: "${ctx.previous}" — say something different.`);
  return L.join(' ');
}

/* =====================================================================
 * เรียกผู้ให้บริการ AI
 * ===================================================================== */
async function callOpenAICompatible(url, key, model, lang, ctx, extraHeaders) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(extraHeaders || {}) },
    body: JSON.stringify({
      model,
      max_tokens: 80,
      temperature: 0.9,
      messages: [
        { role: 'system', content: systemPrompt(lang) },
        { role: 'user', content: describeState(ctx, lang) },
      ],
    }),
  }, CFG.timeoutMs);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content;
  if (!text) throw new Error('ไม่มีข้อความตอบกลับ');
  return cleanup(text);
}

function cleanup(text) {
  return String(text)
    .replace(/[*_`#>]/g, '')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/* =====================================================================
 * ตัวควบคุมหลัก — หนึ่งตัวต่อหนึ่งการถ่ายทอด
 * ===================================================================== */
class MCEngine {
  constructor(opts = {}) {
    this.lang = opts.lang || CFG.lang;
    this.enabled = opts.enabled ?? CFG.enabled;
    this.lastAt = 0;
    this.lastText = '';
    this.busy = false;
    this.source = 'canned';       // groq | openrouter | canned
    this.failUntil = { groq: 0, openrouter: 0 };
  }

  setLang(lang) { if (CANNED[lang]) this.lang = lang; }

  get hasAI() { return !!(CFG.groqKey || CFG.orKey); }

  /** พูดได้แล้วหรือยัง (กันพูดรัวเกินไป) */
  ready(now = Date.now(), force = false) {
    if (!this.enabled) return false;
    if (this.busy) return false;
    return force || (now - this.lastAt >= CFG.minGapMs);
  }

  /** เงียบมานานเกินไปหรือยัง */
  idle(now = Date.now()) {
    return this.enabled && !this.busy && (now - this.lastAt >= CFG.idleMs);
  }

  /**
   * สร้างประโยคพากย์
   * @param {object} ctx บริบทของเกม
   * @param {string} kind idle | move | capture | start | byoyomi | end | cut
   * @returns {Promise<{text:string, source:string, lang:string}>}
   */
  async say(ctx, kind = 'idle') {
    this.busy = true;
    try {
      const now = Date.now();
      let text = null;

      if (CFG.groqKey && now > this.failUntil.groq) {
        try {
          text = await callOpenAICompatible(
            'https://api.groq.com/openai/v1/chat/completions',
            CFG.groqKey, CFG.groqModel, this.lang, { ...ctx, previous: this.lastText });
          this.source = 'groq';
        } catch (e) {
          console.warn('[mc] Groq ใช้ไม่ได้:', e.message);
          this.failUntil.groq = now + 60_000;     // พัก 1 นาทีค่อยลองใหม่
        }
      }

      if (!text && CFG.orKey && now > this.failUntil.openrouter) {
        try {
          text = await callOpenAICompatible(
            'https://openrouter.ai/api/v1/chat/completions',
            CFG.orKey, CFG.orModel, this.lang, { ...ctx, previous: this.lastText },
            { 'X-Title': 'Go Battle Live' });
          this.source = 'openrouter';
        } catch (e) {
          console.warn('[mc] OpenRouter ใช้ไม่ได้:', e.message);
          this.failUntil.openrouter = now + 60_000;
        }
      }

      if (!text) {                                 // ทางสำรองสุดท้าย — ไม่มีวันเงียบ
        text = pickCanned(this.lang, kind, this.lastText);
        this.source = 'canned';
      }

      this.lastAt = Date.now();
      this.lastText = text;
      return { text, source: this.source, lang: this.lang };
    } finally {
      this.busy = false;
    }
  }
}

/** สร้างบริบทจากห้องเกม */
function contextFromRoom(room, extra = {}) {
  const g = room.game;
  const p = room.seats;
  const clockB = room.clocks[1], clockW = room.clocks[2];
  return {
    size: g.size,
    komi: g.komi,
    moveCount: g.history.length,
    turn: g.turn,
    capB: g.prisoners[1],
    capW: g.prisoners[2],
    ko: g.koPoint != null,
    byoyomi: !!(clockB?.inByoyomi || clockW?.inByoyomi),
    blackName: p[1]?.name || '—',
    whiteName: p[2]?.name || '—',
    blackRank: extra.blackRank || '—',
    whiteRank: extra.whiteRank || '—',
    ...extra,
  };
}

/** ปรับค่าตอนรัน (ใช้เมื่อผู้กำกับบันทึกคีย์จากหน้าตั้งค่า) */
function setConfig(patch = {}) {
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    CFG[k] = patch[k];
  }
}

/** สรุปสถานะสำหรับหน้าตั้งค่า — ไม่ส่งคีย์กลับไปให้เบราว์เซอร์เห็น */
function configSummary() {
  const mask = k => (k ? '••••' + k.slice(-4) : '');
  return {
    groqKeySet: !!CFG.groqKey,
    groqKeyHint: mask(CFG.groqKey),
    orKeySet: !!CFG.orKey,
    orKeyHint: mask(CFG.orKey),
    groqModel: CFG.groqModel,
    orModel: CFG.orModel,
    lang: CFG.lang,
    minGapMs: CFG.minGapMs,
    idleMs: CFG.idleMs,
    enabled: CFG.enabled,
  };
}

module.exports = { MCEngine, contextFromRoom, CANNED, pickCanned, cleanup, CFG, setConfig, configSummary };
