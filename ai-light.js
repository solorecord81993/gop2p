/* =====================================================================
 * GO BATTLE LIVE — ai-light.js  v1.0
 * AI ชั้นเบา สำหรับระดับ 20–13 คิว  (ไม่ต้องใช้เซิร์ฟเวอร์ AI แยก)
 *
 * วิธีคิด: heuristic ล้วน ไม่มี neural net
 *   1. จับกินได้ -> กินหมู่ที่ใหญ่ที่สุด
 *   2. หมู่ตัวเองโดนอาตาริ -> หนีหรือกินคืน
 *   3. ที่เหลือ -> สุ่มแบบถ่วงน้ำหนัก ชอบจุดใกล้หมากเดิม เลี่ยงตาตัวเอง
 *
 * strength 0..1 : ยิ่งต่ำยิ่งพลาดบ่อย (ใช้กำหนดระดับคิว)
 * ===================================================================== */

const { BLACK, WHITE, EMPTY } = require('./go-engine.js');
const opposite = c => (c === BLACK ? WHITE : BLACK);

// จุดนั้นเป็น "ตา" ของสี c หรือไม่ (เดินลงไปเองมักเสียเปล่า)
function isOwnEye(game, x, y, c) {
  if (game.get(x, y) !== EMPTY) return false;
  for (const [nx, ny] of game.neighbors(x, y)) {
    if (game.get(nx, ny) !== c) return false;
  }
  // ตรวจมุมทแยง — ต้องเป็นของเราเป็นส่วนใหญ่ ไม่งั้นเป็นตาปลอม
  const diag = [[x-1,y-1],[x+1,y-1],[x-1,y+1],[x+1,y+1]].filter(([a,b]) => game.onBoard(a,b));
  const bad  = diag.filter(([a,b]) => game.get(a,b) === opposite(c)).length;
  const edge = 4 - diag.length;
  return edge > 0 ? bad === 0 : bad <= 1;
}

// เจ้าของพื้นที่ของแต่ละจุดว่าง (0 = ยังไม่มีเจ้าของ / ดาเมะ)
function territoryOwner(game) {
  const N = game.size, b = game.board;
  const owner = new Int8Array(N * N), seen = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    if (b[i] !== EMPTY || seen[i]) continue;
    const pts = [], borders = new Set(), stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); pts.push(j);
      const jx = j % N, jy = (j / N) | 0;
      for (const [nx, ny] of game.neighbors(jx, jy)) {
        const ni = ny * N + nx;
        if (b[ni] === EMPTY) { if (!seen[ni]) { seen[ni] = 1; stack.push(ni); } }
        else borders.add(b[ni]);
      }
    }
    if (borders.size === 1) { const c = [...borders][0]; for (const p of pts) owner[p] = c; }
  }
  return owner;
}

function legalMoves(game, c) {
  const out = [];
  // กติกาญี่ปุ่น: ลงในพื้นที่ของตัวเองมีแต่เสียแต้ม จึงตัดออกจากตัวเลือก
  const owner = territoryOwner(game);
  for (let y = 0; y < game.size; y++)
    for (let x = 0; x < game.size; x++) {
      const i = y * game.size + x;
      if (owner[i] === c) continue;
      if (game.isLegal(x, y, c) && !isOwnEye(game, x, y, c)) out.push([x, y]);
    }
  return out;
}

// ประเมินคะแนนของแต่ละตา
function scoreMove(game, x, y, c, strength) {
  let s = 0;
  const foe = opposite(c);

  // ผลของการวางจริง
  const i = game.idx(x, y);
  game.board[i] = c;

  let captured = 0, atariFoe = 0;
  for (const [nx, ny] of game.neighbors(x, y)) {
    if (game.board[game.idx(nx, ny)] === foe) {
      const g = game.group(nx, ny);
      if (g.liberties.size === 0) captured += g.stones.length;
      else if (g.liberties.size === 1) atariFoe += g.stones.length;
    }
  }
  const own = game.group(x, y);
  const ownLibs = own.liberties.size;
  game.board[i] = EMPTY;

  s += captured * 12;                 // กินได้ = ดีมาก
  s += atariFoe * 4;                  // ไล่อาตาริ = ดี
  if (ownLibs === 1 && captured === 0) s -= 10;   // วางแล้วโดนอาตาริทันที = แย่
  s += Math.min(ownLibs, 4) * 1.5;

  // ช่วยหมู่ตัวเองที่กำลังโดนอาตาริ
  for (const [nx, ny] of game.neighbors(x, y)) {
    if (game.get(nx, ny) === c) {
      const g = game.group(nx, ny);
      if (g.liberties.size === 1 && ownLibs > 1) s += g.stones.length * 8;
    }
  }

  // ชอบเล่นใกล้หมากที่มีอยู่ ไม่กระจายมั่ว
  let near = 0;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const a = x + dx, b = y + dy;
      if (game.onBoard(a, b) && game.get(a, b) !== EMPTY) near++;
    }
  s += Math.min(near, 6) * 0.8;

  // เลี่ยงเส้นแรกช่วงต้นเกม
  const edge = Math.min(x, y, game.size - 1 - x, game.size - 1 - y);
  if (edge === 0 && game.history.length < game.size * 2) s -= 6;
  if (edge === 2 || edge === 3) s += 1.5;

  // ความไม่แน่นอนตามระดับฝีมือ: strength ต่ำ = สุ่มเยอะ
  s += (Math.random() - 0.5) * (30 * (1 - strength) + 2);
  return s;
}

/**
 * เลือกตาเดินของ AI
 * @param {GoGame} game
 * @param {number} color BLACK/WHITE
 * @param {number} strength 0..1 (0.15≈20คิว, 0.35≈15คิว, 0.6≈10คิว)
 * @returns {{pass:boolean, x?:number, y?:number}}
 */
function chooseMove(game, color, strength = 0.35) {
  const moves = legalMoves(game, color);
  if (moves.length === 0) return { pass: true };

  let best = null, bestScore = -Infinity;
  for (const [x, y] of moves) {
    const sc = scoreMove(game, x, y, color, strength);
    if (sc > bestScore) { bestScore = sc; best = [x, y]; }
  }
  return { pass: false, x: best[0], y: best[1] };
}

const STRENGTH_BY_RANK = { '20k': 0.10, '18k': 0.18, '15k': 0.32, '13k': 0.45, '10k': 0.60 };

module.exports = { chooseMove, legalMoves, isOwnEye, territoryOwner, STRENGTH_BY_RANK };
