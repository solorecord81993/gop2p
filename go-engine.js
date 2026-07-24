/* =====================================================================
 * GO BATTLE LIVE — go-engine.js  v1.0
 * เอนจินกติกาโกะแบบญี่ปุ่น ตามสมาคมกีฬาหมากล้อมแห่งประเทศไทย
 *
 *  - นับแต้มแบบญี่ปุ่น (พื้นที่ + เชลย, ไม่นับเม็ดบนกระดาน, ดาเมะไม่เป็นแต้ม)
 *  - โคะแบบง่าย (basic ko) ไม่ใช่ positional superko
 *  - ตรวจจับซันโคะ / การวนซ้ำ -> ไม่มีผลแพ้ชนะ
 *  - เดาหมากตายด้วย Benson's algorithm (unconditional life) เป็นตัวตั้งต้น
 *    แล้วให้ผู้เล่นทั้งสองยืนยัน
 *  - ส่งออก SGF
 *
 * ใช้ได้ทั้งใน Node (เซิร์ฟเวอร์เกม) และในเบราว์เซอร์ ไม่มี dependency
 * ===================================================================== */

/* ห่อด้วย IIFE เพื่อไม่ให้ตัวแปรรั่วไปชนกับสคริปต์อื่นในหน้าเดียวกัน
   (บั๊กเดิม: go-engine.js กับ i18n.js ประกาศ EXPORTS ซ้ำกัน
    ทำให้ไฟล์ที่โหลดทีหลังพังทั้งไฟล์ และหน้าเว็บกลายเป็นช่องว่างเปล่า) */
(function () {
'use strict';


const EMPTY = 0, BLACK = 1, WHITE = 2;

const KOMI_BY_SIZE = { 9: 1.5, 13: 3.5, 19: 6.5 };   // ตามที่สมาคมฯ ประกาศ

// จุดดาวสำหรับวางแต้มต่อ
const HANDICAP_POINTS = {
  9:  [[6,2],[2,6],[6,6],[2,2],[4,4],[0,4],[8,4],[4,0],[4,8]],
  13: [[9,3],[3,9],[9,9],[3,3],[6,6],[0,6],[12,6],[6,0],[6,12]],
  19: [[15,3],[3,15],[15,15],[3,3],[9,9],[3,9],[15,9],[9,3],[9,15]],
};

const opposite = c => (c === BLACK ? WHITE : BLACK);

class GoGame {
  constructor(opts = {}) {
    this.size     = opts.size ?? 9;
    this.komi     = opts.komi ?? KOMI_BY_SIZE[this.size] ?? 6.5;
    this.handicap = opts.handicap ?? 0;

    this.board    = new Uint8Array(this.size * this.size);
    this.prisoners = { [BLACK]: 0, [WHITE]: 0 };   // จำนวนเม็ดที่ฝ่ายนั้น "จับได้"
    this.history  = [];        // {color,x,y,pass,captured}
    this.koPoint  = null;      // ตำแหน่งห้ามกินคืนทันที
    this.turn     = BLACK;
    this.passes   = 0;
    this.state    = 'playing'; // playing | marking | finished | no_result
    this.result   = null;

    this.positionCounts = new Map();  // แฮชกระดาน -> จำนวนครั้งที่เกิด (ตรวจซันโคะ)

    if (this.handicap >= 2) this._placeHandicap();
    this._recordPosition();
  }

  /* ---------------- พื้นฐาน ---------------- */
  idx(x, y) { return y * this.size + x; }
  onBoard(x, y) { return x >= 0 && y >= 0 && x < this.size && y < this.size; }
  get(x, y) { return this.board[this.idx(x, y)]; }

  neighbors(x, y) {
    const out = [];
    if (x > 0)             out.push([x - 1, y]);
    if (x < this.size - 1) out.push([x + 1, y]);
    if (y > 0)             out.push([x, y - 1]);
    if (y < this.size - 1) out.push([x, y + 1]);
    return out;
  }

  _placeHandicap() {
    const pts = (HANDICAP_POINTS[this.size] || []).slice(0, this.handicap);
    for (const [x, y] of pts) this.board[this.idx(x, y)] = BLACK;
    this.komi = 0;          // ธรรมเนียม: เกมแต้มต่อ โคมิ = 0
    this.turn = WHITE;      // ขาวเดินก่อน
  }

  /* ---------------- หมู่และลมหายใจ ---------------- */
  // คืน {stones:[i], liberties:Set<i>} ของหมู่ที่มีจุด (x,y)
  group(x, y) {
    const color = this.get(x, y);
    if (color === EMPTY) return null;
    const stones = [], seen = new Set(), libs = new Set();
    const stack = [this.idx(x, y)];
    seen.add(stack[0]);
    while (stack.length) {
      const i = stack.pop();
      stones.push(i);
      const cx = i % this.size, cy = (i / this.size) | 0;
      for (const [nx, ny] of this.neighbors(cx, cy)) {
        const ni = this.idx(nx, ny), v = this.board[ni];
        if (v === EMPTY) libs.add(ni);
        else if (v === color && !seen.has(ni)) { seen.add(ni); stack.push(ni); }
      }
    }
    return { stones, liberties: libs, color };
  }

  /* ---------------- ตรวจความถูกต้องของตา ---------------- */
  // คืน null ถ้าเดินได้ หรือ "รหัสเหตุผล" ถ้าเดินไม่ได้
  // ใช้รหัสแทนข้อความ เพื่อให้หน้าเว็บแปลเป็นภาษาที่ผู้เล่นเลือกได้
  // รหัสทั้งหมด: game_over | not_your_turn | off_board | occupied | ko | suicide
  illegalReason(x, y, color) {
    if (this.state !== 'playing')       return 'game_over';
    if (color !== this.turn)            return 'not_your_turn';
    if (!this.onBoard(x, y))            return 'off_board';
    const i = this.idx(x, y);
    if (this.board[i] !== EMPTY)        return 'occupied';
    if (this.koPoint === i)             return 'ko';

    // ลองวางแล้วดูผล
    this.board[i] = color;
    let captures = 0;
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.board[this.idx(nx, ny)] === opposite(color)) {
        const g = this.group(nx, ny);
        if (g.liberties.size === 0) captures += g.stones.length;
      }
    }
    const own = this.group(x, y);
    const suicide = captures === 0 && own.liberties.size === 0;
    this.board[i] = EMPTY;

    if (suicide) return 'suicide';
    return null;
  }

  isLegal(x, y, color) { return this.illegalReason(x, y, color) === null; }

  /* ---------------- เดิน ---------------- */
  play(x, y, color) {
    const reason = this.illegalReason(x, y, color);
    if (reason) return { ok: false, error: reason };

    const i = this.idx(x, y);
    this.board[i] = color;

    // จับกิน
    const capturedStones = [];
    for (const [nx, ny] of this.neighbors(x, y)) {
      if (this.board[this.idx(nx, ny)] === opposite(color)) {
        const g = this.group(nx, ny);
        if (g.liberties.size === 0) {
          for (const si of g.stones) { this.board[si] = EMPTY; capturedStones.push(si); }
        }
      }
    }
    this.prisoners[color] += capturedStones.length;

    // โคะแบบง่าย: กินได้ 1 เม็ด และหมู่ที่เพิ่งวางมี 1 เม็ด 1 ลมหายใจ
    const own = this.group(x, y);
    this.koPoint = (capturedStones.length === 1 &&
                    own.stones.length === 1 &&
                    own.liberties.size === 1)
                   ? capturedStones[0] : null;

    this.history.push({ color, x, y, pass: false, captured: capturedStones.length });
    this.passes = 0;
    this.turn = opposite(color);

    // ตรวจการวนซ้ำ (ซันโคะ / อายุยาว)
    const repeated = this._recordPosition();
    if (repeated >= 3) {
      this.state  = 'no_result';
      this.result = { type: 'no_result', text: 'ไม่มีผลแพ้ชนะ (ตำแหน่งซ้ำ — ซันโคะ)' };
      return { ok: true, captured: capturedStones, noResult: true };
    }

    return { ok: true, captured: capturedStones };
  }

  pass(color) {
    if (this.state !== 'playing') return { ok: false, error: 'game_over' };
    if (color !== this.turn)      return { ok: false, error: 'not_your_turn' };
    this.history.push({ color, pass: true });
    this.koPoint = null;
    this.passes += 1;
    this.turn = opposite(color);
    if (this.passes >= 2) {
      // กติกาญี่ปุ่น: หยุดนาฬิกา แล้วเข้าเฟสตกลงหมากตาย
      this.state = 'marking';
      return { ok: true, enterMarking: true, deadGuess: this.guessDeadStones() };
    }
    return { ok: true };
  }

  resign(color) {
    this.state = 'finished';
    this.result = {
      type: color === BLACK ? 'white_win' : 'black_win',
      text: (color === BLACK ? 'W+R' : 'B+R'),
      reason: 'ยอมแพ้', reasonCode: 'resign',
    };
    return this.result;
  }

  /* ---------------- Benson: หมู่ที่มีชีวิตแน่นอน ---------------- */
  // คืน Set ของ index เม็ดที่อยู่ในหมู่ pass-alive ของสีนั้น
  bensonPassAlive(color) {
    const N = this.size;
    // 1) รวบรวมหมู่ทั้งหมดของ color
    const chainId = new Int32Array(N * N).fill(-1);
    const chains = [];
    for (let i = 0; i < N * N; i++) {
      if (this.board[i] === color && chainId[i] === -1) {
        const g = this.group(i % N, (i / N) | 0);
        const id = chains.length;
        for (const si of g.stones) chainId[si] = id;
        chains.push({ id, stones: g.stones, alive: true });
      }
    }
    // 2) รวบรวม region: กลุ่มจุดที่ "ไม่ใช่สีเรา" ติดกัน
    const regionId = new Int32Array(N * N).fill(-1);
    const regions = [];
    for (let i = 0; i < N * N; i++) {
      if (this.board[i] !== color && regionId[i] === -1) {
        const pts = [], stack = [i];
        regionId[i] = regions.length;
        while (stack.length) {
          const j = stack.pop(); pts.push(j);
          const jx = j % N, jy = (j / N) | 0;
          for (const [nx, ny] of this.neighbors(jx, jy)) {
            const ni = this.idx(nx, ny);
            if (this.board[ni] !== color && regionId[ni] === -1) {
              regionId[ni] = regions.length; stack.push(ni);
            }
          }
        }
        // หมู่ของ color ที่ล้อม region นี้
        const border = new Set();
        for (const p of pts) {
          const px = p % N, py = (p / N) | 0;
          for (const [nx, ny] of this.neighbors(px, py)) {
            const ni = this.idx(nx, ny);
            if (this.board[ni] === color) border.add(chainId[ni]);
          }
        }
        const emptyPts = pts.filter(p => this.board[p] === EMPTY);
        regions.push({ id: regions.length, pts, emptyPts, border, alive: true });
      }
    }
    // region "vital" ต่อหมู่ X ถ้าทุกจุดว่างใน region เป็นลมหายใจของ X
    const isVital = (region, chain) => {
      const chainSet = new Set(chain.stones);
      if (region.emptyPts.length === 0) return false;
      return region.emptyPts.every(p => {
        const px = p % N, py = (p / N) | 0;
        return this.neighbors(px, py).some(([nx, ny]) => chainSet.has(this.idx(nx, ny)));
      });
    };

    // 3) วนตัดทิ้งจนนิ่ง
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of chains) {
        if (!c.alive) continue;
        let vital = 0;
        for (const r of regions) {
          if (r.alive && r.border.has(c.id) && isVital(r, c)) vital++;
        }
        if (vital < 2) { c.alive = false; changed = true; }
      }
      for (const r of regions) {
        if (!r.alive) continue;
        for (const cid of r.border) {
          if (!chains[cid].alive) { r.alive = false; changed = true; break; }
        }
      }
    }

    const out = new Set();
    for (const c of chains) if (c.alive) for (const s of c.stones) out.add(s);
    return out;
  }

  /* ---------------- เดาหมากตาย (ตัวตั้งต้น ต้องให้คนยืนยัน) ---------------- */
  guessDeadStones() {
    const N = this.size;
    const aliveB = this.bensonPassAlive(BLACK);
    const aliveW = this.bensonPassAlive(WHITE);
    const dead = new Set();

    // หมู่ที่ไม่ pass-alive และไม่มีเพื่อนที่ pass-alive อยู่ในบริเวณเดียวกัน
    // และถูกล้อมด้วยหมู่ pass-alive ของฝ่ายตรงข้าม -> เดาว่าตาย
    const seen = new Set();
    for (let i = 0; i < N * N; i++) {
      const c = this.board[i];
      if (c === EMPTY || seen.has(i)) continue;
      const g = this.group(i % N, (i / N) | 0);
      for (const s of g.stones) seen.add(s);
      const myAlive = c === BLACK ? aliveB : aliveW;
      if (myAlive.has(g.stones[0])) continue;   // มีชีวิตแน่นอน ไม่ตาย

      // ดูว่าเพื่อนบ้านรอบหมู่นี้เป็นหมู่ pass-alive ของฝ่ายตรงข้ามทั้งหมดหรือไม่
      const foeAlive = c === BLACK ? aliveW : aliveB;
      let surroundedByAlive = true, touched = false;
      for (const s of g.stones) {
        const sx = s % N, sy = (s / N) | 0;
        for (const [nx, ny] of this.neighbors(sx, sy)) {
          const ni = this.idx(nx, ny);
          if (this.board[ni] === opposite(c)) {
            touched = true;
            if (!foeAlive.has(ni)) surroundedByAlive = false;
          }
        }
      }
      if (touched && surroundedByAlive && g.liberties.size <= 4) {
        for (const s of g.stones) dead.add(s);
      }
    }
    return [...dead];
  }

  /* ---------------- นับแต้มแบบญี่ปุ่น ---------------- */
  // deadStones: array ของ index ที่ทั้งสองฝ่ายตกลงว่าตายแล้ว
  score(deadStones = []) {
    const N = this.size;
    const b = Uint8Array.from(this.board);
    const prisoners = { [BLACK]: this.prisoners[BLACK], [WHITE]: this.prisoners[WHITE] };

    // ยกหมากตายออก แล้วนับเป็นเชลยของฝ่ายตรงข้าม
    for (const i of deadStones) {
      const c = b[i];
      if (c === EMPTY) continue;
      prisoners[opposite(c)] += 1;
      b[i] = EMPTY;
    }

    // นับพื้นที่: บริเวณว่างที่ล้อมด้วยสีเดียวล้วน
    const territory = { [BLACK]: 0, [WHITE]: 0 };
    const neutral = [];              // ดาเมะ — ไม่เป็นแต้มของใคร
    const seen = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      if (b[i] !== EMPTY || seen[i]) continue;
      const pts = [], borders = new Set(), stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop(); pts.push(j);
        const jx = j % N, jy = (j / N) | 0;
        for (const [nx, ny] of this.neighbors(jx, jy)) {
          const ni = this.idx(nx, ny);
          if (b[ni] === EMPTY) { if (!seen[ni]) { seen[ni] = 1; stack.push(ni); } }
          else borders.add(b[ni]);
        }
      }
      if (borders.size === 1) territory[[...borders][0]] += pts.length;
      else neutral.push(...pts);
    }

    const black = territory[BLACK] + prisoners[BLACK];
    const white = territory[WHITE] + prisoners[WHITE] + this.komi;
    const diff  = black - white;

    let text;
    if (diff > 0)      text = `B+${diff.toFixed(1).replace(/\.0$/, '')}`;
    else if (diff < 0) text = `W+${(-diff).toFixed(1).replace(/\.0$/, '')}`;
    else               text = 'Draw';

    return {
      black, white, diff, text,
      territory: { black: territory[BLACK], white: territory[WHITE] },
      prisoners: { black: prisoners[BLACK], white: prisoners[WHITE] },
      komi: this.komi,
      dameCount: neutral.length,
    };
  }

  finalize(deadStones = []) {
    const s = this.score(deadStones);
    this.state = 'finished';
    this.result = {
      type: s.diff > 0 ? 'black_win' : s.diff < 0 ? 'white_win' : 'draw',
      text: s.text,
      score: s,
    };
    return this.result;
  }

  /* ---------------- ตรวจตำแหน่งซ้ำ ---------------- */
  _positionKey() {
    let k = '';
    for (let i = 0; i < this.board.length; i++) k += this.board[i];
    return k + '|' + this.turn;
  }
  _recordPosition() {
    const k = this._positionKey();
    const n = (this.positionCounts.get(k) || 0) + 1;
    this.positionCounts.set(k, n);
    return n;
  }

  /* ---------------- SGF ---------------- */
  toSGF(meta = {}) {
    const L = 'abcdefghijklmnopqrs';
    let sgf = `(;GM[1]FF[4]CA[UTF-8]AP[GoBattleLive:1.0]`
            + `SZ[${this.size}]KM[${this.komi}]RU[Japanese]`;
    if (this.handicap >= 2) sgf += `HA[${this.handicap}]`;
    if (meta.playerBlack) sgf += `PB[${meta.playerBlack}]`;
    if (meta.playerWhite) sgf += `PW[${meta.playerWhite}]`;
    if (meta.blackRank)   sgf += `BR[${meta.blackRank}]`;
    if (meta.whiteRank)   sgf += `WR[${meta.whiteRank}]`;
    if (meta.event)       sgf += `EV[${meta.event}]`;
    if (meta.date)        sgf += `DT[${meta.date}]`;
    if (this.result)      sgf += `RE[${this.result.text}]`;

    if (this.handicap >= 2) {
      const pts = HANDICAP_POINTS[this.size].slice(0, this.handicap);
      sgf += 'AB' + pts.map(([x, y]) => `[${L[x]}${L[y]}]`).join('');
    }
    for (const m of this.history) {
      const c = m.color === BLACK ? 'B' : 'W';
      sgf += m.pass ? `;${c}[]` : `;${c}[${L[m.x]}${L[m.y]}]`;
    }
    return sgf + ')';
  }

  /* ---------------- สแนปช็อตสำหรับส่งผ่าน WebSocket ---------------- */
  snapshot() {
    return {
      size: this.size,
      komi: this.komi,
      handicap: this.handicap,
      board: Array.from(this.board),
      turn: this.turn,
      prisoners: { black: this.prisoners[BLACK], white: this.prisoners[WHITE] },
      koPoint: this.koPoint,
      moveCount: this.history.length,
      lastMove: this.history.length
        ? this.history[this.history.length - 1] : null,
      state: this.state,
      result: this.result,
    };
  }
}

const __EXPORTS__ = { GoGame, EMPTY, BLACK, WHITE, KOMI_BY_SIZE, HANDICAP_POINTS };
if (typeof module !== 'undefined' && module.exports) module.exports = __EXPORTS__;
if (typeof window !== 'undefined') window.GoEngine = __EXPORTS__;
})();
