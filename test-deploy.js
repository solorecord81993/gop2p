/* =====================================================================
 * ตรวจ deployment contract สำหรับ Docker + KataGo ที่ติดตั้งอัตโนมัติ
 * ไม่ดาวน์โหลดไฟล์และไม่ต้องมี Docker daemon
 * ===================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { settingsFromEnv } = require('./neural-ai.js');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
let pass = 0;
let fail = 0;

function ok(name, condition) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
  }
}

const dockerfile = read('Dockerfile');
const render = read('render.yaml');
const config = read('katago/analysis.cfg');

console.log('\n[Docker + KataGo deployment]');

ok('ตรึง KataGo release และตรวจ checksum ของ binary',
   /ARG KATAGO_VERSION=1\.16\.5/.test(dockerfile) &&
   /KATAGO_ARCHIVE_SHA256=[a-f0-9]{64}/.test(dockerfile) &&
   /sha256sum --check --strict/.test(dockerfile));

ok('ตรึง neural net ทางการและตรวจ checksum ของ model',
   /ARG KATAGO_MODEL=kata1-b15c192-s449394432-d140458288\.txt\.gz/.test(dockerfile) &&
   /KATAGO_MODEL_SHA256=[a-f0-9]{64}/.test(dockerfile) &&
   /media\.katagotraining\.org/.test(dockerfile));

ok('แตก AppImage ล่วงหน้า จึงไม่ต้องใช้ FUSE ใน container',
   /--appimage-extract/.test(dockerfile) &&
   /runtime\/AppRun/.test(dockerfile));

ok('image กำหนด local KataGo paths ครบและรันแบบ non-root',
   /KATAGO_BIN=\/opt\/katago\/katago/.test(dockerfile) &&
   /KATAGO_MODEL=\/opt\/katago\/model\.txt\.gz/.test(dockerfile) &&
   /KATAGO_CONFIG=\/app\/katago\/analysis\.cfg/.test(dockerfile) &&
   /\nUSER node\n/.test(dockerfile));

ok('Render ใช้ Docker Free และค้างผล AI หนึ่งนาที',
   /runtime:\s*docker/.test(render) &&
   /plan:\s*free/.test(render) &&
   /dockerfilePath:\s*\.\/Dockerfile/.test(render) &&
   /key:\s*AI_RESULT_HOLD_MS\s*\n\s*value:\s*"60000"/.test(render) &&
   /key:\s*KATAGO_MAX_VISITS\s*\n\s*value:\s*"32"/.test(render) &&
   /key:\s*KATAGO_ROOT_SYMMETRIES\s*\n\s*value:\s*"1"/.test(render) &&
   /key:\s*KATAGO_TIMEOUT_MS\s*\n\s*value:\s*"120000"/.test(render));

ok('CPU config จำกัด thread, batch และ cache สำหรับ container ขนาดเล็ก',
   /maxVisits\s*=\s*32/.test(config) &&
   /rootNumSymmetriesToSample\s*=\s*1/.test(config) &&
   /numEigenThreadsPerModel\s*=\s*1/.test(config) &&
   /nnMaxBatchSize\s*=\s*2/.test(config) &&
   /nnCacheSizePowerOfTwo\s*=\s*16/.test(config) &&
   /maxBoardXSizeForNNBuffer\s*=\s*19/.test(config));

const settings = settingsFromEnv({
  KATAGO_BIN: '/opt/katago/katago',
  KATAGO_MODEL: '/opt/katago/model.txt.gz',
  KATAGO_CONFIG: '/app/katago/analysis.cfg',
  KATAGO_MAX_VISITS: '32',
  KATAGO_ROOT_SYMMETRIES: '1',
  KATAGO_TIMEOUT_MS: '120000',
});
ok('environment ของ image เปิด neural local mode อัตโนมัติ',
   /KATAGO_MAX_VISITS=32/.test(dockerfile) &&
   /KATAGO_ROOT_SYMMETRIES=1/.test(dockerfile) &&
   /KATAGO_TIMEOUT_MS=120000/.test(dockerfile) &&
   settings.mode === 'local' &&
   settings.maxVisits === 32 &&
   settings.rootSymmetries === 1 &&
   settings.timeoutMs === 120_000);

console.log('\n════════════════════════════════');
console.log(`  ผ่าน ${pass} · ล้มเหลว ${fail}`);
console.log('════════════════════════════════');
process.exit(fail ? 1 : 0);
