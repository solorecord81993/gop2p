/* =====================================================================
 * ทดสอบ KataGo neural adapter + เส้นทาง User vs AI และ AI vs AI
 * ไม่ต้องมี binary/model จริง เพราะจำลอง Analysis Engine endpoint
 * ===================================================================== */

'use strict';

process.env.KATAGO_API_URL = 'https://katago.test/analyze';
process.env.KATAGO_API_KEY = 'test-secret';
process.env.KATAGO_MAX_VISITS = '321';
process.env.KATAGO_ROOT_SYMMETRIES = '8';
process.env.KATAGO_TIMEOUT_MS = '1500';
process.env.KATAGO_RETRY_COOLDOWN_MS = '0';
process.env.AI_DELAY_MS = '0';

const WebSocket = require('ws');
const { GoGame, BLACK, WHITE } = require('./go-engine.js');
const {
  KataGoClient,
  buildAnalysisQuery,
  chooseFromAnalysis,
  toGtp,
  fromGtp,
} = require('./neural-ai.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log('  ok   ' + name))
       : (fail++, console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')));
};

class Client {
  constructor(port) {
    this.inbox = [];
    this.state = null;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ready = new Promise(resolve => this.ws.on('open', resolve));
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      this.inbox.push(message);
      if (message.t === 'state' || message.t === 'end') this.state = message;
    });
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  wait(type, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const index = this.inbox.findIndex(message => message.t === type);
        if (index >= 0) {
          clearInterval(timer);
          resolve(this.inbox.splice(index, 1)[0]);
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error(`หมดเวลารอ ${type}`));
        }
      }, 10);
    });
  }
  waitState(predicate, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.state && predicate(this.state)) {
          clearInterval(timer);
          resolve(this.state);
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error('หมดเวลารอสถานะ neural'));
        }
      }, 10);
    });
  }
  close() { this.ws.close(); }
}

async function testAdapter() {
  console.log('\n[Neural adapter]');
  ok('แปลงพิกัด GTP และข้ามคอลัมน์ I ถูกต้อง',
     toGtp(0, 0, 9) === 'A9' && toGtp(8, 8, 9) === 'J1' &&
     fromGtp('J1', 9).x === 8 && fromGtp('J1', 9).y === 8);

  const game = new GoGame({ size: 9, komi: 1.5 });
  game.play(4, 4, BLACK);
  const query = buildAnalysisQuery(game, WHITE, {
    id: 'unit-query',
    maxVisits: 777,
    rootSymmetries: 8,
  });
  ok('สร้าง query ตาม KataGo Analysis Engine protocol',
     query.id === 'unit-query' && query.initialPlayer === 'W' &&
     query.rules === 'japanese' && query.komi === 1.5 &&
     query.boardXSize === 9 && query.boardYSize === 9 &&
     query.maxVisits === 777 && query.initialStones.some(stone => stone[1] === 'E5') &&
     query.overrideSettings.rootNumSymmetriesToSample === 8);

  const selected = chooseFromAnalysis(game, WHITE, {
    moveInfos: [
      { move: 'E5', order: 0, visits: 500 }, // จุดนี้มีหมากอยู่ ต้องข้าม
      { move: 'C7', order: 1, visits: 100, winrate: 0.75, scoreLead: 4.5 },
    ],
  });
  ok('ข้าม candidate ที่ผิดกติกาและเลือกตา neural ถัดไป',
     !selected.pass && selected.x === 2 && selected.y === 2 &&
     selected.neural.visits === 100);

  let request = null;
  const client = new KataGoClient({
    mode: 'remote',
    apiUrl: 'https://katago.test/unit',
    apiKey: 'unit-key',
    maxVisits: 900,
    rootSymmetries: 8,
    timeoutMs: 1000,
    cooldownMs: 0,
  }, {
    fetch: async (url, options) => {
      request = { url, options, query: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: request.query.id,
          isDuringSearch: false,
          moveInfos: [{ move: 'D6', order: 0, visits: 900 }],
        }),
      };
    },
  });
  const move = await client.chooseMove(game, WHITE);
  ok('remote adapter ส่ง Bearer key และคืนตาเดินได้',
     request.url === 'https://katago.test/unit' &&
     request.options.headers.Authorization === 'Bearer unit-key' &&
     request.query.maxVisits === 900 &&
     move.x === 3 && move.y === 3 &&
     client.publicStatus().state === 'online');
}

async function testBothGameModes() {
  console.log('\n[Neural ทั้งสองโหมด]');
  const neuralQueries = [];
  let failNextNeuralRequest = false;
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url) !== process.env.KATAGO_API_URL) return originalFetch(url, options);
    const query = JSON.parse(options.body);
    neuralQueries.push(query);
    if (failNextNeuralRequest) {
      failNextNeuralRequest = false;
      return { ok: false, status: 503, text: async () => 'GPU temporarily unavailable' };
    }
    const moveInfos = [];
    let order = 0;
    for (let y = 0; y < query.boardYSize; y++) {
      for (let x = 0; x < query.boardXSize; x++) {
        moveInfos.push({ move: toGtp(x, y, query.boardXSize), order: order++, visits: 321 });
      }
    }
    moveInfos.push({ move: 'pass', order: order++, visits: 1 });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: query.id, isDuringSearch: false, moveInfos }),
    };
  };

  // ต้อง require หลังติดตั้ง fetch จำลอง เพราะ server จับ transport ตอนสร้าง singleton
  delete require.cache[require.resolve('./server.js')];
  const server = require('./server.js');
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const player = new Client(port);
    await player.ready;
    player.send({ t: 'auth', name: 'ผู้ทดสอบ' });
    const welcome = await player.wait('welcome');
    const neuralLevel = welcome.aiLevels.find(level => level.id === 'neuralMax');
    ok('หน้าผู้เล่นเห็น Neural Superhuman พร้อมเลือกเมื่อกำหนด endpoint',
       neuralLevel?.engine === 'neural' && neuralLevel.available === true &&
       welcome.neural?.configured === true);

    player.send({
      t: 'create',
      size: 9,
      vsAI: true,
      aiLevel: 'neuralMax',
      timeRule: { main: 300, byoyomi: 30, periods: 3 },
    });
    await player.wait('joined');
    player.send({ t: 'ready' });
    await player.waitState(state => state.state === 'playing');
    player.send({ t: 'play', x: 4, y: 4 });
    const answered = await player.waitState(state => state.game.moveCount >= 2);
    ok('User vs AI เรียก neural network และเดินตอบจริง',
       neuralQueries.some(query => query.initialPlayer === 'W') &&
       answered.players.white.aiEngine === 'neural' &&
       answered.players.white.aiEngineStatus === 'online');

    failNextNeuralRequest = true;
    player.send({ t: 'play', x: 5, y: 5 });
    const fallback = await player.waitState(state =>
      state.game.moveCount >= 4 && state.players.white.aiEngineStatus === 'fallback');
    ok('endpoint ล่มกลางเกมแล้วไม่ค้างและติดสถานะ FALLBACK ตรงตามจริง',
       fallback.players.white.aiEngine === 'neural' &&
       fallback.players.white.aiEngineStatus === 'fallback');

    const director = new Client(port);
    await director.ready;
    director.send({ t: 'auth', name: 'director' });
    await director.wait('welcome');
    director.send({ t: 'director_auth', token: 'dev-director' });
    const auth = await director.wait('director_ok');
    ok('หน้า control ได้สถานะ KataGo และระดับ neural เดียวกัน',
       auth.neural?.configured === true &&
       auth.aiLevels.find(level => level.id === 'neuralMax')?.available === true);

    const before = neuralQueries.length;
    director.send({
      t: 'director_create_ai_game',
      size: 9,
      blackLevel: 'neuralMax',
      whiteLevel: 'neuralMax',
    });
    const created = await director.wait('ai_game_created');
    director.send({ t: 'watch', codes: [created.code] });
    const advanced = await director.waitState(state =>
      state.code === created.code && state.game.moveCount >= 2);
    const battleQueries = neuralQueries.slice(before);
    ok('AI vs AI ใช้ neural network ทั้งฝั่งดำและขาว',
       battleQueries.some(query => query.initialPlayer === 'B') &&
       battleQueries.some(query => query.initialPlayer === 'W') &&
       advanced.players.black.aiEngine === 'neural' &&
       advanced.players.white.aiEngine === 'neural');
    ok('หน้า control เห็นสถานะ neural แยกทุกฝั่ง',
       ['online', 'thinking'].includes(advanced.players.black.aiEngineStatus) &&
       ['online', 'thinking'].includes(advanced.players.white.aiEngineStatus));

    director.send({ t: 'director_close_room', code: created.code });
    await director.wait('room_closed');
    player.close();
    director.close();
  } finally {
    server.neuralAI.close();
    await new Promise(resolve => server.close(resolve));
    global.fetch = originalFetch;
  }
}

(async () => {
  try {
    await testAdapter();
    await testBothGameModes();
  } catch (error) {
    fail++;
    console.log('  FAIL การทดสอบหยุดกลางคัน → ' + error.stack);
  }
  console.log('\n════════════════════════════════');
  console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
  console.log('════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
