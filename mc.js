/* =====================================================================
 * GO BATTLE LIVE — mc.js  v1.0
 * ระบบพากย์อัตโนมัติสำหรับการถ่ายทอดสด
 *
 * ลำดับการทำงาน:
 *   1) เรียก Groq  (เร็วและฟรีในโควตาหนึ่ง)
 *   2) ถ้าไม่ได้ ลอง OpenRouter
 *   3) ถ้ายังไม่ได้อีก ใช้คำพากย์สำเร็จรูปที่เขียนไว้ โดยอิงชื่อผู้เล่นและสถานะเกม
 *
 * ออกแบบให้ "ไม่มีวันเงียบ" — ต่อให้ไม่ได้ใส่คีย์ AI เลย MC ก็ยังพูดแบบมีข้อมูล
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
    invite: [
      'สแกน QR เข้ามาสร้างเกมและเล่นกับเพื่อนหรือ AI ได้เลยครับ',
      'ถ้าอยากลงสนามเอง สแกน QR แล้วสร้างเกมได้เลยครับ',
      'ใครพร้อมประลองหมากล้อมกับเพื่อนหรือ AI เชิญสแกน QR ได้เลยครับ',
      'กดไลก์กดแชร์เป็นกำลังใจให้ผู้เล่นของเราได้นะครับ',
    ],
    idle: [
      'ฝากกดไลก์กดแชร์เป็นกำลังใจให้ผู้เล่นทั้งสองคนด้วยนะครับ',
      'ทุกไลก์ทุกแชร์ช่วยเติมกำลังใจให้นักหมากล้อมของเราครับ',
      'ถ้าชอบเกมนี้ช่วยกดไลก์กดแชร์ให้ผู้เล่นด้วยนะครับ',
      'ร่วมส่งกำลังใจให้การแข่งขันหมากล้อมคู่นี้ด้วยการกดไลก์กดแชร์ครับ',
      'เกมยังมีหลายจังหวะให้ลุ้นครับ ฝากช่วยเชียร์ผู้เล่นด้วยไลก์และแชร์นะครับ',
      'ใครกำลังดูอยู่ ส่งแรงใจให้ทั้งสองฝ่ายกันหน่อยครับ',
    ],
    move:    ['ตานี้มีผลกับรูปเกมมากครับ ฝากกดไลก์กดแชร์เป็นกำลังใจด้วยนะครับ', 'ผู้เล่นกำลังวางแผนอย่างเต็มที่ ช่วยกดไลก์กดแชร์ให้ทั้งคู่ครับ', 'หมากตานี้เปลี่ยนจังหวะเกมได้เลยครับ ฝากส่งกำลังใจด้วยการกดไลก์กดแชร์นะครับ', 'ทุกตาบนกระดานมีความหมาย ช่วยกดไลก์กดแชร์ให้ผู้เล่นด้วยครับ'],
    capture: ['จับกินได้แล้วครับ ฝากกดไลก์กดแชร์เป็นกำลังใจให้ผู้เล่นทั้งคู่ด้วยนะครับ', 'หมู่นี้ถูกจับกิน รูปเกมเปลี่ยนทันทีครับ ช่วยกดไลก์กดแชร์ด้วยนะครับ', 'มีการปะทะครั้งใหญ่บนกระดานครับ ทุกไลก์ทุกแชร์ช่วยเชียร์ผู้เล่นได้มากเลย', 'เสียหมากไปหนึ่งกลุ่มครับ ฝากกดไลก์กดแชร์ให้กำลังใจทั้งสองฝ่ายนะครับ'],
    start:   [
      'เปิดกระดานใหม่แล้วครับ มาติดตามการแข่งขันหมากล้อมคู่นี้กัน ฝากกดไลก์กดแชร์ด้วยนะครับ',
      'เราไปดูกันต่อที่อีกหนึ่งเกมหมากล้อมครับ ช่วยส่งแรงเชียร์ให้ผู้เล่นทั้งคู่ด้วยนะครับ',
      'พร้อมลุ้นเกมใหม่กันหรือยังครับ ฝากกดไลก์กดแชร์เป็นกำลังใจให้นักหมากล้อมของเราด้วยครับ',
      'กระดานต่อไปมาแล้วครับ ใครจะคุมพื้นที่ได้ดีกว่า ฝากติดตามและช่วยเชียร์กันด้วยนะครับ',
      'ได้เวลาจับตาเกมหมากล้อมอีกคู่ครับ ทุกตาอาจเปลี่ยนรูปเกมได้เลย',
      'สลับมาที่กระดานใหม่แล้วครับ มาดูกันว่าผู้เล่นคู่นี้จะวางแผนกันอย่างไร',
      'อีกเกมกำลังรอให้เราไปลุ้นครับ ฝากกดไลก์กดแชร์ให้ผู้เล่นทั้งสองฝ่ายด้วยนะครับ',
      'เปลี่ยนมุมมาดูเกมนี้กันครับ ขอแรงเชียร์ให้ทั้งคู่ก่อนเริ่มการต่อสู้บนกระดาน',
    ],
    byoyomi: ['เวลาเข้าสู่ช่วงเบียวโยมิแล้วครับ ฝากกดไลก์กดแชร์ช่วยส่งกำลังใจให้ผู้เล่นด้วยนะครับ', 'เวลาน้อยลงทุกทีครับ ทุกไลก์ทุกแชร์ช่วยให้ผู้เล่นมีแรงสู้ต่อครับ'],
    end:     ['จบเกมแล้วครับ ขอบคุณทุกไลก์ทุกแชร์ที่ส่งกำลังใจให้ผู้เล่นนะครับ', 'ผลการแข่งขันออกแล้วครับ ฝากกดไลก์กดแชร์ให้ทั้งคู่และติดตามเกมต่อไปด้วยนะครับ'],
    cut:     ['ค่ายกลสำคัญเกิดขึ้นแล้วครับ ฝากกดไลก์กดแชร์เป็นกำลังใจให้ผู้เล่นด้วยนะครับ', 'ตานี้มีชั้นเชิงมากครับ ช่วยกดไลก์กดแชร์ให้การแข่งขันหมากล้อมด้วยนะครับ'],
  },
  en: {
    invite: [
      'Scan the QR code to create a game and play with friends or AI.',
      'Ready to play? Scan the QR code and create your own Go match.',
      'Challenge a friend or an AI opponent by scanning the QR code.',
      'Tap like and share to cheer on our players.',
    ],
    idle: [
      'Tap like and share to support both players in this Go match.',
      'Every like and share gives our Go players more encouragement.',
      'If you enjoy this game, tap like and share for the players.',
      'Show your support for this Go battle with a like and a share.',
    ],
    move:    ['This move could change the game, so tap like and share for the players.', 'Both players are fighting hard; show support with a like and a share.', 'This move changes the balance, so keep the encouragement coming with likes and shares.', 'Every move matters in this Go match; tap like and share for both players.'],
    capture: ['A major capture changes the game; tap like and share for both players.', 'That group is gone and the balance shifts; show support with a like and a share.', 'A big fight just happened on the board; every like and share helps the players.', 'A group has been captured; keep cheering with likes and shares.'],
    start:   [
      'A new Go board is on air; tap like and share to support both players.',
      'We are moving to another Go match, so stay with us and cheer for the players.',
      'A fresh battle is ready; every move could shape the game, so keep the support coming.',
      'The next board is live; let us see who controls the corners and the center.',
      'Here comes another Go match; tap like and share before the fighting begins.',
      'We are switching to a new board; watch how these two players build their plans.',
      'Another game is waiting for us; show both players some encouragement with a like and a share.',
      'Let us follow this next battle together and see who takes the initiative.',
    ],
    byoyomi: ['They are in byo-yomi now; tap like and share to encourage the players under pressure.', 'The clock is running low; every like and share helps the players keep fighting.'],
    end:     ['The game is over; thank you for every like and share supporting the players.', 'The result is in; tap like and share for both players and follow the next match.'],
    cut:     ['A key tesuji just appeared; tap like and share to support the players.', 'That is a beautiful tactical moment; show support with a like and a share.'],
  },
  ja: {
    invite: [
      'QRコードを読み取って、友達やAIと対局しましょう。',
      '対局の準備ができたら、QRコードからゲームを作成してください。',
      '友達やAIに挑戦するなら、QRコードを読み取ってください。',
      'いいねとシェアで対局者を応援してください。',
    ],
    idle: [
      'いいねとシェアで両対局者を応援してください。',
      '皆さんのいいねとシェアが対局者の力になります。',
      'この対局を楽しんだら、いいねとシェアをお願いします。',
      'いいねとシェアで、この囲碁対局を盛り上げてください。',
    ],
    move:    ['この一手が勝負を変えるかもしれません。いいねとシェアで応援してください。', '両者が全力で戦っています。いいねとシェアをお願いします。', '形勢を変える一手です。いいねとシェアで力を送ってください。', '一手一手が大切です。両対局者をいいねとシェアで応援してください。'],
    capture: ['大きな戦いで石を取りました。いいねとシェアで応援してください。', '一団が取られ、形勢が動きました。いいねとシェアをお願いします。', '盤上で大きな衝突です。皆さんのいいねとシェアが力になります。', '石が取られました。両対局者をいいねとシェアで応援してください。'],
    start:   [
      '新しい囲碁対局をお届けします。いいねとシェアで両対局者を応援してください。',
      '次の盤面に切り替わりました。二人の戦いを一緒に見届けましょう。',
      '新たな勝負が始まります。どちらが主導権を握るのか注目です。',
      '次の囲碁対局です。隅と中央をどう使うのか、じっくりご覧ください。',
      '盤上の新しい戦いが始まります。いいねとシェアをお願いします。',
      '次の対局へ移ります。この二人がどんな構想を見せるのか楽しみです。',
      'もう一つの勝負を見ていきましょう。両対局者への応援をお願いします。',
      '新しいゲームが始まります。最後まで一緒に応援してください。',
    ],
    byoyomi: ['秒読みに入りました。いいねとシェアで対局者を応援してください。', '時間が少なくなっています。皆さんのいいねとシェアが力になります。'],
    end:     ['対局が終わりました。応援のいいねとシェアをありがとうございました。', '結果が出ました。いいねとシェアで両対局者を応援してください。'],
    cut:     ['大切な手筋が現れました。いいねとシェアで応援してください。', '見事な戦術の場面です。いいねとシェアをお願いします。'],
  },
};

/* =====================================================================
 * ตัวช่วย
 * ===================================================================== */
function pickCanned(lang, kind, avoid) {
  const bank = (CANNED[lang] || CANNED.th)[kind] || (CANNED[lang] || CANNED.th).idle;
  return pickLine(bank, avoid);
}

const PLACEHOLDER_NAMES = new Set(['', '—', '-', '?']);
const hasName = name => !PLACEHOLDER_NAMES.has(String(name || '').trim());
const hasMatch = ctx => hasName(ctx?.blackName) && hasName(ctx?.whiteName);

function compactForCompare(text) {
  return String(text || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function isRepeatedText(text, previous = []) {
  const current = compactForCompare(text);
  if (!current) return true;
  const list = Array.isArray(previous) ? previous : [previous];
  return list.some(item => {
    const old = compactForCompare(item);
    if (!old) return false;
    if (old === current) return true;
    const shorter = Math.min(old.length, current.length);
    return shorter >= 28 && (old.includes(current) || current.includes(old));
  });
}

function pickLine(lines, avoid = []) {
  const previous = Array.isArray(avoid) ? avoid : [avoid];
  const fresh = lines.filter(line => !isRepeatedText(line, previous));
  if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)] || '';
  // If every line is inside the recent history, at least avoid saying the
  // immediately previous line again. This matters when a board is switched
  // repeatedly and the same commentary category is requested each time.
  const latest = previous.find(Boolean);
  const notLatest = latest
    ? lines.filter(line => compactForCompare(line) !== compactForCompare(latest))
    : lines;
  const pool = notLatest.length ? notLatest : lines;
  return pool[Math.floor(Math.random() * pool.length)] || '';
}

function scoreNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/** ประเมินคะแนนระหว่างเกมแบบเดียวกับแถบคะแนนในหน้า Live */
function estimatePosition(game) {
  const N = Number(game?.size);
  const board = game?.board;
  if (!Number.isInteger(N) || !board || board.length !== N * N) return null;

  const neighbors = typeof game.neighbors === 'function'
    ? (x, y) => game.neighbors(x, y)
    : (x, y) => [
        ...(x > 0 ? [[x - 1, y]] : []),
        ...(x < N - 1 ? [[x + 1, y]] : []),
        ...(y > 0 ? [[x, y - 1]] : []),
        ...(y < N - 1 ? [[x, y + 1]] : []),
      ];
  let influence = new Float32Array(N * N);
  for (let i = 0; i < board.length; i++) {
    influence[i] = board[i] === 1 ? 48 : board[i] === 2 ? -48 : 0;
  }
  for (let pass = 0; pass < 4; pass++) {
    const next = Float32Array.from(influence);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let total = influence[i], count = 1;
      for (const [nx, ny] of neighbors(x, y)) {
        total += influence[ny * N + nx];
        count++;
      }
      next[i] = total / count;
    }
    influence = next;
  }

  let territoryBlack = 0, territoryWhite = 0;
  for (const value of influence) {
    if (value > 3) territoryBlack++;
    else if (value < -3) territoryWhite++;
  }
  const prisoners = game.prisoners || {};
  const black = territoryBlack + Number(prisoners[1] || prisoners.black || 0);
  const white = territoryWhite + Number(prisoners[2] || prisoners.white || 0) + Number(game.komi || 0);
  return {
    black: Math.round(black),
    white: Math.round(white * 10) / 10,
    diff: black - white,
    exact: false,
  };
}

function standingText(ctx, lang = 'th') {
  if (ctx?.winnerName) {
    if (lang === 'en') return `${ctx.winnerName} is the winner${ctx.resultText ? `, ${ctx.resultText}` : ''}`;
    if (lang === 'ja') return `${ctx.winnerName}の勝利${ctx.resultText ? `、${ctx.resultText}` : ''}`;
    return `${ctx.winnerName} เป็นฝ่ายชนะ${ctx.resultText ? ` ${ctx.resultText}` : ''}`;
  }

  const diff = Number(ctx?.scoreDiff);
  if (!Number.isFinite(diff) || !ctx?.leadName || !ctx?.trailName) {
    if (lang === 'en') return 'the position is still too close to call';
    if (lang === 'ja') return '形勢はまだ接近しています';
    return 'ตอนนี้คะแนนยังสูสีกันมาก';
  }
  if (Math.abs(diff) < 0.25) {
    if (lang === 'en') return `${ctx.leadName} and ${ctx.trailName} are level`;
    if (lang === 'ja') return `${ctx.leadName}と${ctx.trailName}は互角です`;
    return `${ctx.leadName} กับ ${ctx.trailName} ยังสูสีมาก`;
  }

  const points = scoreNumber(Math.abs(diff));
  const approx = ctx.scoreExact ? '' : (lang === 'en' ? 'about ' : lang === 'ja' ? '約' : 'ประมาณ ');
  if (lang === 'en') return `${ctx.leadName} leads by ${approx}${points} points, with ${ctx.trailName} behind`;
  if (lang === 'ja') return `${ctx.leadName}が${approx}${points}目ほどリードし、${ctx.trailName}が追っています`;
  return `${ctx.leadName} นำ${approx}${points} แต้ม ส่วน ${ctx.trailName} ตามอยู่`;
}

function cannedForContext(ctx, kind = 'idle', avoid = []) {
  if (!hasMatch(ctx)) return pickCanned(ctx?.lang || 'th', kind, avoid);
  const lang = ctx.lang || 'th';
  const black = ctx.blackName, white = ctx.whiteName;
  const matchup = pickLine(lang === 'en'
    ? [
        `This Go match is between ${black} and ${white}`,
        `${black} and ${white} are facing off in this Go match`,
        `We are watching ${black} against ${white}`,
      ]
    : lang === 'ja'
      ? [
          `この囲碁対局は${black}と${white}の対戦です`,
          `${black}と${white}が盤上で戦っています`,
          `${black}対${white}の囲碁対局をお届けします`,
        ]
      : [
          `นี่คือการแข่งขันหมากล้อมระหว่าง ${black} กับ ${white}`,
          `${black} กำลังดวลหมากล้อมกับ ${white}`,
          `เรากำลังติดตามเกมของ ${black} พบกับ ${white}`,
        ], avoid);
  const standing = standingText(ctx, lang);
  const cta = pickLine(lang === 'en'
    ? [
        'Tap like and share to support both players.',
        'Show your support with a like and a share.',
        'Keep the encouragement coming for both players.',
        'If you enjoy this match, share it with your friends.',
      ]
    : lang === 'ja'
      ? [
          'いいねとシェアで両対局者を応援してください。',
          '皆さんの応援をいいねとシェアで届けてください。',
          'この対局が気に入ったら、友達にもシェアしてください。',
          '両対局者に応援を送りましょう。',
        ]
      : [
          'ฝากกดไลก์กดแชร์เป็นกำลังใจให้ผู้เล่นทั้งคู่ด้วยนะครับ',
          'ช่วยส่งแรงเชียร์ให้ทั้งสองฝ่ายด้วยไลก์และแชร์นะครับ',
          'ถ้าชอบเกมนี้ ฝากแชร์ต่อและกดไลก์ให้ผู้เล่นด้วยนะครับ',
          'ทุกไลก์ทุกแชร์มีความหมาย ช่วยเชียร์ผู้เล่นกันครับ',
        ], avoid);
  const moveCount = Number.isFinite(Number(ctx.moveCount)) ? Number(ctx.moveCount) : 0;
  const progress = lang === 'en'
    ? (moveCount > 0 ? `The game is already ${moveCount} moves in` : 'The game is just getting started')
    : lang === 'ja'
      ? (moveCount > 0 ? `${moveCount}手まで進んでいます` : '対局が始まったばかりです')
      : (moveCount > 0 ? `เกมเดินมาแล้ว ${moveCount} ตา` : 'เกมกำลังจะเริ่ม');
  const turn = ctx.turnName && hasName(ctx.turnName)
    ? (lang === 'en' ? `${ctx.turnName} to play` : lang === 'ja' ? `${ctx.turnName}の手番です` : `ตาของ ${ctx.turnName}`)
    : '';
  const result = ctx.resultText
    ? (lang === 'en' ? `The result is ${ctx.resultText}` : lang === 'ja' ? `結果は${ctx.resultText}です` : `ผลการแข่งขันคือ ${ctx.resultText}`)
    : '';

  const lines = {
    th: {
      start: [
        `${matchup} ครับ ${progress} ตอนนี้${standing} ${cta}`,
        `กลับมาดูเกมของ ${black} กับ ${white} กันครับ ${progress} ${standing} ${cta}`,
        `กระดานนี้น่าจับตาครับ ${matchup} ${standing} ${cta}`,
        `${matchup} ครับ ${turn || 'ทั้งคู่กำลังวางแผน'} ตอนนี้${standing} ${cta}`,
        `สลับมาที่เกมนี้แล้วครับ ${progress} ตอนนี้${standing} ${cta}`,
        `ขอพาไปดูเกมของ ${black} พบกับ ${white} ครับ ${standing} ${cta}`,
        `${matchup} กำลังชิงจังหวะกันครับ ${progress} ${standing} ${cta}`,
        `มาเช็กสถานการณ์บนกระดานนี้กันครับ ${matchup} ${standing} ${cta}`,
      ],
      idle: [`${matchup} ครับ ตอนนี้${standing} ${cta}`, `${matchup} กำลังเข้มข้นครับ ${standing} ${cta}`, `${matchup} ${turn} ตอนนี้${standing} ${cta}`, `${matchup} ครับ อย่าพลาดจังหวะสำคัญ ${standing} ${cta}`],
      move: [`${matchup} ครับ ${turn} ตอนนี้${standing} ${cta}`, `${matchup} เดินหมากต่อเนื่องครับ ${standing} ${cta}`, `${matchup} ครับ ตานี้อาจเปลี่ยนเกมได้ ตอนนี้${standing} ${cta}`, `${matchup} กำลังชิงพื้นที่กันครับ ${standing} ${cta}`],
      capture: [`${matchup} ครับ มีการจับกินแล้ว ตอนนี้${standing} ${cta}`, `${matchup} เกิดการปะทะใหญ่บนกระดานครับ ${standing} ${cta}`, `${matchup} ครับ หมากถูกจับกินและรูปเกมเปลี่ยนแล้ว ${standing} ${cta}`, `${matchup} กำลังสู้กันหนักครับ ${standing} ${cta}`],
      byoyomi: [`${matchup} ครับ เข้าช่วงเบียวโยมิแล้ว ${standing} ${cta}`, `${matchup} กำลังแข่งกับเวลาครับ ${standing} ${cta}`],
      end: [`${matchup} ครับ ${result || standing} ขอบคุณสำหรับทุกไลก์ทุกแชร์ครับ`, `${matchup} จบเกมแล้วครับ ${result || standing} ${cta}`],
      cut: [`${matchup} ครับ เกิดค่ายกลสำคัญขึ้นแล้ว ${standing} ${cta}`, `${matchup} มีจังหวะชั้นเชิงบนกระดานครับ ${standing} ${cta}`],
    },
    en: {
      start: [
        `${matchup}; ${progress}, and ${standing}. ${cta}`,
        `Let us return to ${black} versus ${white}; ${progress}. ${standing}. ${cta}`,
        `This board is worth watching. ${matchup}; ${standing}. ${cta}`,
        `${matchup}; ${turn || 'both players are planning carefully'}, and ${standing}. ${cta}`,
        `We are switching to this game; ${progress}. The position is ${standing}. ${cta}`,
        `Here is ${black} against ${white}; ${standing}. ${cta}`,
        `${matchup}; the players are fighting for the initiative. ${standing}. ${cta}`,
        `Let us check this board together. ${matchup}; ${standing}. ${cta}`,
      ],
      idle: [`${matchup}; ${standing}. ${cta}`, `${matchup}; ${standing}. Keep supporting the players.`, `${matchup}; ${turn}, and ${standing}. ${cta}`, `${matchup}; do not miss this key stretch. ${standing}. ${cta}`],
      move: [`${matchup}; ${turn}, and ${standing}. ${cta}`, `${matchup}; this move could change the game. ${standing}. ${cta}`, `${matchup}; both players are fighting for position. ${standing}. ${cta}`, `${matchup}; every move matters. ${standing}. ${cta}`],
      capture: [`${matchup}; a capture just changed the board. ${standing}. ${cta}`, `${matchup}; a major fight has erupted. ${standing}. ${cta}`, `${matchup}; stones have been captured and the balance shifts. ${standing}. ${cta}`, `${matchup}; this group is gone. ${standing}. ${cta}`],
      byoyomi: [`${matchup}; they are in byo-yomi. ${standing}. ${cta}`, `${matchup}; the clock is tight. ${standing}. ${cta}`],
      end: [`${matchup}; ${result || standing}. Thank you for every like and share.`, `${matchup}; the game is over. ${result || standing}. ${cta}`],
      cut: [`${matchup}; a key tesuji just appeared. ${standing}. ${cta}`, `${matchup}; that is a beautiful tactical moment. ${standing}. ${cta}`],
    },
    ja: {
      start: [
        `${matchup}。${progress}。${standing}。${cta}`,
        `${black}対${white}の対局に戻りましょう。${progress}。${standing}。${cta}`,
        `この盤面は注目です。${matchup}。${standing}。${cta}`,
        `${matchup}。${turn || '両者が慎重に考えています'}。${standing}。${cta}`,
        `この対局へ切り替わりました。${progress}。${standing}。${cta}`,
        `${black}と${white}の戦いを見ていきましょう。${standing}。${cta}`,
        `${matchup}。主導権をめぐる戦いです。${standing}。${cta}`,
        `この盤面の形勢を確認しましょう。${matchup}。${standing}。${cta}`,
      ],
      idle: [`${matchup}。${standing}。${cta}`, `${matchup}。${turn}、${standing}。${cta}`, `${matchup}。大切な場面です。${standing}。${cta}`, `${matchup}。盤上から目が離せません。${standing}。${cta}`],
      move: [`${matchup}。${turn}、${standing}。${cta}`, `${matchup}。この一手で形勢が動くかもしれません。${standing}。${cta}`, `${matchup}。両者が陣地を争っています。${standing}。${cta}`, `${matchup}。一手一手が大切です。${standing}。${cta}`],
      capture: [`${matchup}。石を取り、盤面が動きました。${standing}。${cta}`, `${matchup}。大きな戦いが起きています。${standing}。${cta}`, `${matchup}。一団が取られ、形勢が変わりました。${standing}。${cta}`, `${matchup}。この石の損失は大きいです。${standing}。${cta}`],
      byoyomi: [`${matchup}。秒読みに入りました。${standing}。${cta}`, `${matchup}。時間との戦いです。${standing}。${cta}`],
      end: [`${matchup}。${result || standing}。応援のいいねとシェアをありがとうございました。`, `${matchup}。対局終了です。${result || standing}。${cta}`],
      cut: [`${matchup}。大切な手筋が現れました。${standing}。${cta}`, `${matchup}。見事な戦術の場面です。${standing}。${cta}`],
    },
  };
  const bank = lines[lang]?.[kind] || lines[lang]?.idle || lines.th.idle;
  return pickLine(bank, avoid);
}

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

const LANG_NAME = { th: 'Thai', en: 'English', ja: 'Japanese' };

function systemPrompt(lang, kind) {
  return [
    'You are a live commentator for an online Go (baduk/weiqi) match streamed on TikTok.',
    `Reply ONLY in ${LANG_NAME[lang] || 'Thai'}.`,
    'Give exactly ONE spoken sentence, at most 20 words, suitable for text-to-speech.',
    'Be energetic and specific, but never invent facts that are not in the given state.',
    'No emoji, no markdown, no quotation marks, no move coordinates unless given.',
    'Do not use vague filler such as tension is building, interesting move, or do not look away.',
    'Sound like a natural live commentator: vary sentence openings and avoid repeating stock phrases, especially after switching boards.',
    'For start commentary, acknowledge the new board and whether the game is just starting or already in progress.',
    'When two player names are provided, mention that this is their Go match and say who leads and who trails, using the estimated score honestly.',
    'Include a natural call to tap like and share to support the players, but vary the wording.',
    `Commentary type: ${kind}.`,
  ].join(' ');
}

function describeState(ctx, lang, kind) {
  const L = [];
  L.push(`Board ${ctx.size}x${ctx.size}, komi ${ctx.komi}.`);
  L.push(`Black: ${ctx.blackName} (${ctx.blackRank}). White: ${ctx.whiteName} (${ctx.whiteRank}).`);
  L.push(`Move ${ctx.moveCount}, ${ctx.turn === 1 ? 'Black' : 'White'} to play.`);
  L.push(`Captures — black ${ctx.capB}, white ${ctx.capW}.`);
  if (ctx.blackScore != null && ctx.whiteScore != null) {
    L.push(`Current ${ctx.scoreExact ? 'final' : 'estimated'} score — black ${ctx.blackScore}, white ${ctx.whiteScore}.`);
  }
  if (ctx.leadName && ctx.trailName) {
    L.push(`Current standing: ${ctx.leadName} leads and ${ctx.trailName} trails${ctx.scoreDiff != null ? ` by ${Math.abs(ctx.scoreDiff).toFixed(1)} points` : ''}.`);
  }
  if (ctx.winnerName) L.push(`Winner: ${ctx.winnerName}${ctx.resultText ? ` (${ctx.resultText})` : ''}.`);
  if (ctx.turnName) L.push(`It is ${ctx.turnName}'s turn.`);
  if (ctx.lastCapture) L.push(`A group of ${ctx.lastCapture} stones was just captured.`);
  if (ctx.ko) L.push('There is an active ko.');
  if (ctx.byoyomi) L.push('A player is in byo-yomi with very little time.');
  if (ctx.event) L.push(`Event: ${ctx.event}.`);
  if (ctx.pattern) L.push(`A tesuji just appeared: ${ctx.pattern}.`);
  L.push(`This is a ${kind} commentary. Ask viewers to like and share as encouragement.`);
  if (ctx.previous) L.push(`Your previous line was: "${ctx.previous}" — say something different.`);
  return L.join(' ');
}

/* =====================================================================
 * เรียกผู้ให้บริการ AI
 * ===================================================================== */
async function callOpenAICompatible(url, key, model, lang, ctx, kind, extraHeaders) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(extraHeaders || {}) },
    body: JSON.stringify({
      model,
      max_tokens: 80,
      temperature: 0.9,
      messages: [
        { role: 'system', content: systemPrompt(lang, kind) },
        { role: 'user', content: describeState(ctx, lang, kind) },
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
    .slice(0, 220);
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
    this.recentTexts = [];
    this.busy = false;
    this.source = 'canned';       // groq | openrouter | canned
    this.failUntil = { groq: 0, openrouter: 0 };
  }

  setLang(lang) {
    if (CANNED[lang]) {
      this.lang = lang;
      this.recentTexts = [];
      this.lastText = '';
    }
  }

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
      const state = { ...(ctx || {}), lang: this.lang };
      const previous = [this.lastText, ...this.recentTexts].filter(Boolean);
      const accept = (candidate, source) => {
        const cleaned = cleanup(candidate);
        if (!cleaned || isRepeatedText(cleaned, previous)) return false;
        text = cleaned;
        this.source = source;
        return true;
      };

      // With no game on air, only use the curated invitation copy. Sending a
      // dummy board to an AI made it commentate matches that had already ended.
      if (kind === 'invite') {
        accept(cannedForContext(state, kind, previous), 'canned');
      }

      if (!text && CFG.groqKey && now > this.failUntil.groq) {
        try {
          accept(await callOpenAICompatible(
            'https://api.groq.com/openai/v1/chat/completions',
            CFG.groqKey, CFG.groqModel, this.lang, { ...state, previous: this.lastText }, kind), 'groq');
        } catch (e) {
          console.warn('[mc] Groq ใช้ไม่ได้:', e.message);
          this.failUntil.groq = now + 60_000;     // พัก 1 นาทีค่อยลองใหม่
        }
      }

      if (!text && CFG.orKey && now > this.failUntil.openrouter) {
        try {
          accept(await callOpenAICompatible(
            'https://openrouter.ai/api/v1/chat/completions',
            CFG.orKey, CFG.orModel, this.lang, { ...state, previous: this.lastText }, kind,
            { 'X-Title': 'Go Battle Live' }), 'openrouter');
        } catch (e) {
          console.warn('[mc] OpenRouter ใช้ไม่ได้:', e.message);
          this.failUntil.openrouter = now + 60_000;
        }
      }

      if (!text) {                                 // ทางสำรองสุดท้าย — ไม่มีวันเงียบ
        for (let i = 0; i < 6 && !text; i++) {
          accept(cannedForContext(state, kind, previous), 'canned');
        }
        if (!text) {
          text = cleanup(cannedForContext(state, kind, []));
          this.source = 'canned';
        }
      }

      this.lastAt = Date.now();
      this.lastText = text;
      this.recentTexts = [text, ...this.recentTexts.filter(item => !isRepeatedText(item, [text]))].slice(0, 10);
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
  const finalScore = room.score || g.result?.score || null;
  const position = finalScore || estimatePosition(g);
  const blackName = p[1]?.name || '—';
  const whiteName = p[2]?.name || '—';
  const result = g.result || null;
  const winnerColor = result?.type === 'black_win' ? 'black'
    : result?.type === 'white_win' ? 'white' : null;
  const scoreDiff = position && Number.isFinite(Number(position.diff))
    ? Number(position.diff) : null;
  const scoreLeadColor = scoreDiff > 0.25 ? 'black' : scoreDiff < -0.25 ? 'white' : null;
  const leadColor = winnerColor || scoreLeadColor;
  const leadName = leadColor === 'black' ? blackName : leadColor === 'white' ? whiteName : null;
  const trailName = leadColor === 'black' ? whiteName : leadColor === 'white' ? blackName : null;
  return {
    size: g.size,
    komi: g.komi,
    moveCount: g.history.length,
    turn: g.turn,
    capB: g.prisoners[1],
    capW: g.prisoners[2],
    ko: g.koPoint != null,
    byoyomi: !!(clockB?.inByoyomi || clockW?.inByoyomi),
    blackName,
    whiteName,
    blackRank: extra.blackRank || '—',
    whiteRank: extra.whiteRank || '—',
    blackScore: position?.black ?? null,
    whiteScore: position?.white ?? null,
    scoreDiff,
    scoreExact: !!finalScore,
    leadColor,
    leadName: hasName(leadName) ? leadName : null,
    trailName: hasName(trailName) ? trailName : null,
    turnName: g.turn === 1 ? blackName : whiteName,
    winnerName: winnerColor === 'black' ? blackName : winnerColor === 'white' ? whiteName : null,
    resultText: result?.text || null,
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

module.exports = {
  MCEngine, contextFromRoom, estimatePosition, cannedForContext,
  CANNED, pickCanned, cleanup, CFG, setConfig, configSummary,
};
