/* =====================================================================
 * GO BATTLE LIVE — settings.js  v1.0
 * เก็บการตั้งค่าจากหน้าผู้กำกับ: คีย์ AI และไฟล์เสียง
 *
 * ที่เก็บ:
 *   - ค่าตั้งค่า  -> ตาราง app_settings ใน Supabase (RLS ปิดสนิท เบราว์เซอร์อ่านไม่ได้)
 *   - ไฟล์เสียง  -> Supabase Storage ถังชื่อ audio (เปิดให้อ่านสาธารณะ)
 *   - ถ้าไม่ได้ตั้ง Supabase จะเก็บไว้ในหน่วยความจำแทน (หายเมื่อรีสตาร์ต)
 *     โหมดนี้มีไว้สำหรับทดสอบในเครื่องเท่านั้น
 * ===================================================================== */

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DB_ON = !!(SUPABASE_URL && SUPABASE_KEY);
const BUCKET = 'audio';

/* ---------------------------------------------------------------------
 * ชนิดไฟล์เสียงที่รองรับ — ระบุให้ชัดเจนทั้ง MIME และนามสกุล
 * หมายเหตุสำคัญ: Safari บน iPhone เล่น OGG ไม่ได้
 * ถ้าจะถ่ายทอดจาก iPhone ให้ใช้ MP3 หรือ M4A เท่านั้น
 * ------------------------------------------------------------------- */
const AUDIO_TYPES = [
  { ext: 'mp3',  mimes: ['audio/mpeg', 'audio/mp3'],                    label: 'MP3',  ios: true  },
  { ext: 'm4a',  mimes: ['audio/mp4', 'audio/x-m4a', 'audio/aac'],      label: 'M4A / AAC', ios: true  },
  { ext: 'wav',  mimes: ['audio/wav', 'audio/x-wav', 'audio/wave'],     label: 'WAV',  ios: true  },
  { ext: 'ogg',  mimes: ['audio/ogg', 'application/ogg'],               label: 'OGG',  ios: false },
  { ext: 'webm', mimes: ['audio/webm'],                                 label: 'WEBM', ios: false },
];
const ACCEPT_EXT   = AUDIO_TYPES.map(t => '.' + t.ext);
const ACCEPT_MIMES = AUDIO_TYPES.flatMap(t => t.mimes);

function typeFromMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return AUDIO_TYPES.find(t => t.mimes.includes(m)) || null;
}

/* ---------------------------------------------------------------------
 * ช่องเสียงทั้งหมด
 * ------------------------------------------------------------------- */
const SLOTS = [
  // เพลงประกอบ — วนไม่มีรอยต่อ ควรเป็นไฟล์ที่ตัดหัวท้ายมาให้ต่อกันพอดี
  { id: 'bgm_lobby',  kind: 'bgm', maxMB: 8, i18n: 'set.bgmLobby'  },
  { id: 'bgm_play',   kind: 'bgm', maxMB: 8, i18n: 'set.bgmPlay'   },
  { id: 'bgm_tense',  kind: 'bgm', maxMB: 8, i18n: 'set.bgmTense'  },
  { id: 'bgm_result', kind: 'bgm', maxMB: 8, i18n: 'set.bgmResult' },
  // เสียงประกอบ — ควรสั้นและเบา
  { id: 'sfx_stone',   kind: 'sfx', maxMB: 1, i18n: 'set.sfxStone'   },
  { id: 'sfx_capture', kind: 'sfx', maxMB: 1, i18n: 'set.sfxCapture' },
  { id: 'sfx_pass',    kind: 'sfx', maxMB: 1, i18n: 'set.sfxPass'    },
  { id: 'sfx_start',   kind: 'sfx', maxMB: 1, i18n: 'set.sfxStart'   },
  { id: 'sfx_end',     kind: 'sfx', maxMB: 1, i18n: 'set.sfxEnd'     },
  // คัตซีนค่ายกล
  { id: 'sfx_cut',     kind: 'cut', maxMB: 2, i18n: 'set.sfxCut'     },
];
const SLOT_IDS = SLOTS.map(s => s.id);

/* ---------------------------------------------------------------------
 * สถานะในหน่วยความจำ
 * ------------------------------------------------------------------- */
const state = {
  audio: {},          // slot -> { url, ext, size, name, updatedAt }
  mc: {},             // groqKey, orKey, groqModel, orModel, lang, minGapMs, idleMs, enabled
  version: 1,
};
const memoryFiles = new Map();   // slot -> { buf, mime, ext }  (ใช้เมื่อไม่มี Supabase)

/* ---------------------------------------------------------------------
 * คุยกับ Supabase
 * ------------------------------------------------------------------- */
async function db(pathname, { method = 'GET', body, prefer, headers } = {}) {
  if (!DB_ON) return null;
  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {}),
    ...(headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method, headers: h, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

/** โหลดการตั้งค่าจากฐานข้อมูลตอนเซิร์ฟเวอร์เริ่มทำงาน */
async function load() {
  if (!DB_ON) return state;
  try {
    const rows = await db('app_settings?select=key,value');
    for (const r of rows || []) {
      if (r.key === 'audio') state.audio = r.value || {};
      if (r.key === 'mc')    state.mc    = r.value || {};
    }
    state.version = Date.now();
  } catch (e) {
    console.warn('[settings] โหลดไม่สำเร็จ:', e.message);
  }
  return state;
}

async function persist(key, value) {
  if (!DB_ON) return;
  try {
    await db('app_settings', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: { key, value, updated_at: new Date().toISOString() },
    });
  } catch (e) {
    console.warn('[settings] บันทึกไม่สำเร็จ:', e.message);
    throw e;
  }
}

/** บันทึกค่าตั้งค่าของ MC */
async function saveMC(patch) {
  state.mc = { ...state.mc, ...patch };
  for (const k of Object.keys(state.mc)) {
    if (state.mc[k] === '' || state.mc[k] === null) delete state.mc[k];
  }
  state.version = Date.now();
  await persist('mc', state.mc);
  return state.mc;
}

/* ---------------------------------------------------------------------
 * อัปโหลดไฟล์เสียง
 * ------------------------------------------------------------------- */
async function uploadAudio(slot, buf, mime, filename) {
  const meta = SLOTS.find(s => s.id === slot);
  if (!meta) throw new Error('ไม่รู้จักช่องเสียงนี้');
  const type = typeFromMime(mime);
  if (!type) {
    throw new Error('ชนิดไฟล์ไม่รองรับ — ใช้ได้เฉพาะ ' + AUDIO_TYPES.map(t => t.label).join(', '));
  }
  const maxBytes = meta.maxMB * 1024 * 1024;
  if (buf.length > maxBytes) throw new Error(`ไฟล์ใหญ่เกิน ${meta.maxMB} MB`);
  if (buf.length < 64) throw new Error('ไฟล์เสียหายหรือว่างเปล่า');

  const objectName = `${slot}.${type.ext}`;
  let url;

  if (DB_ON) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectName}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': type.mimes[0],
        'x-upsert': 'true',
        'cache-control': '3600',
      },
      body: buf,
    });
    if (!res.ok) throw new Error(`อัปโหลดไม่สำเร็จ ${res.status} ${(await res.text()).slice(0, 160)}`);
    url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectName}?v=${Date.now()}`;
  } else {
    memoryFiles.set(slot, { buf, mime: type.mimes[0], ext: type.ext });
    url = `/api/audio/${slot}?v=${Date.now()}`;
  }

  state.audio[slot] = {
    url, ext: type.ext, size: buf.length,
    name: String(filename || '').slice(0, 80) || objectName,
    updatedAt: new Date().toISOString(),
  };
  state.version = Date.now();
  await persist('audio', state.audio);
  return state.audio[slot];
}

async function removeAudio(slot) {
  delete state.audio[slot];
  memoryFiles.delete(slot);
  state.version = Date.now();
  await persist('audio', state.audio);
  if (DB_ON) {
    for (const t of AUDIO_TYPES) {
      try {
        await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${slot}.${t.ext}`, {
          method: 'DELETE',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        });
      } catch {}
    }
  }
}

function getMemoryFile(slot) { return memoryFiles.get(slot) || null; }

/** รายการไฟล์เสียงสำหรับให้เบราว์เซอร์โหลดล่วงหน้า */
function manifest() {
  return {
    version: state.version,
    storage: DB_ON ? 'supabase' : 'memory',
    assets: SLOTS.map(s => ({
      id: s.id,
      kind: s.kind,
      url: state.audio[s.id]?.url || null,
      ext: state.audio[s.id]?.ext || null,
      name: state.audio[s.id]?.name || null,
      size: state.audio[s.id]?.size || 0,
    })),
  };
}

module.exports = {
  SLOTS, SLOT_IDS, AUDIO_TYPES, ACCEPT_EXT, ACCEPT_MIMES,
  state, load, saveMC, uploadAudio, removeAudio, getMemoryFile, manifest,
  DB_ON, typeFromMime,
};
