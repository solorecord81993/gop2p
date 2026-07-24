const {GoGame,BLACK,WHITE,EMPTY} = require('./go-engine.js');
let pass=0,fail=0;
const t=(name,cond)=>{cond?(pass++,console.log('  ok  '+name)):(fail++,console.log('  FAIL '+name));};

// 1 จับกินพื้นฐาน
let g=new GoGame({size:9});
g.play(1,0,BLACK); g.play(0,0,WHITE); g.play(0,1,BLACK);
t('จับกินมุมได้', g.get(0,0)===EMPTY && g.prisoners[BLACK]===1);

// 2 ห้ามฆ่าตัวตาย
g=new GoGame({size:9});
g.board[g.idx(1,0)]=BLACK; g.board[g.idx(0,1)]=BLACK; g.turn=WHITE;
t('ห้ามฆ่าตัวตาย', g.illegalReason(0,0,WHITE)==='suicide');
g.board[g.idx(2,0)]=WHITE; g.board[g.idx(0,2)]=WHITE; g.board[g.idx(1,1)]=WHITE;
t('วางแล้วกินได้ ไม่ถือเป็นฆ่าตัวตาย', g.illegalReason(0,0,WHITE)===null);

// 3 โคะ
g=new GoGame({size:9});
const setup=[[1,0,BLACK],[0,1,BLACK],[1,2,BLACK],[2,0,WHITE],[3,1,WHITE],[2,2,WHITE],[2,1,BLACK]];
setup.forEach(([x,y,c])=>{g.board[g.idx(x,y)]=c;});
g.turn=WHITE;
const r=g.play(1,1,WHITE);
t('กินโคะแล้วเกิดจุดห้ามกินคืน', r.ok && g.koPoint===g.idx(2,1));
t('กินคืนทันทีไม่ได้ (รหัส ko)', g.illegalReason(2,1,BLACK)==='ko');

// 4 นับแต้มญี่ปุ่น: กระดาน 9x9 ดำยึดครึ่งซ้าย ขาวครึ่งขวา
g=new GoGame({size:9,komi:1.5});
for(let y=0;y<9;y++){ g.board[g.idx(4,y)]=BLACK; g.board[g.idx(5,y)]=WHITE; }
let s=g.score([]);
t('พื้นที่ดำ = 36', s.territory.black===36);
t('พื้นที่ขาว = 27', s.territory.white===27);
t('ผลลัพธ์ B+7.5', s.text==='B+7.5');

// 5 ดาเมะไม่เป็นแต้ม
g=new GoGame({size:9,komi:0});
for(let y=0;y<9;y++){ g.board[g.idx(3,y)]=BLACK; g.board[g.idx(5,y)]=WHITE; }
s=g.score([]);
t('ดาเมะ 9 จุดไม่นับให้ใคร', s.dameCount===9 && s.territory.black===27 && s.territory.white===27);

// 6 Benson: หมู่สองตาแท้ต้อง pass-alive / ตาเดียวต้องไม่ใช่
g=new GoGame({size:9});
[[0,1],[1,0],[1,1],[1,2],[1,3],[0,3]].forEach(([x,y])=>{g.board[g.idx(x,y)]=BLACK;});
t('หมู่สองตาแท้ = pass-alive', g.bensonPassAlive(BLACK).has(g.idx(1,1)));

g=new GoGame({size:9});
[[0,1],[1,0],[1,1]].forEach(([x,y])=>{g.board[g.idx(x,y)]=BLACK;});
t('หมู่ตาเดียว = ไม่ pass-alive', g.bensonPassAlive(BLACK).size===0);

// 7 SGF
g=new GoGame({size:9});
g.play(2,2,BLACK); g.play(6,6,WHITE); g.pass(BLACK);
const sgf=g.toSGF({playerBlack:'ดำ',playerWhite:'ขาว'});
t('SGF ถูกรูปแบบ', sgf.startsWith('(;GM[1]') && sgf.includes(';B[cc]') && sgf.includes(';W[gg]') && sgf.includes(';B[]'));

// 8 ผ่านสองครั้ง -> เข้าเฟสตกลงหมากตาย
g=new GoGame({size:9});
g.pass(BLACK); const pr=g.pass(WHITE);
t('ผ่านสองครั้งเข้าเฟส marking', pr.enterMarking===true && g.state==='marking');

// 9 แต้มต่อ
g=new GoGame({size:9,handicap:4});
t('แต้มต่อ 4 เม็ด โคมิ=0 ขาวเดินก่อน', g.komi===0 && g.turn===WHITE && g.board.filter(v=>v===BLACK).length===4);


// ── ทดสอบความทนทาน: ให้ AI เล่นกันเอง 150 เกม ดูว่าไม่ล่มและนับแต้มได้เสมอ ──
{
  const AI = require('./ai-light.js');
  let games=0, crashes=0, badScore=0, totalMoves=0, noResult=0;
  for (let n=0;n<150;n++){
    const size=[9,13][n%2];
    const gg=new GoGame({size});
    try{
      let guard=0;
      while(gg.state==='playing' && guard++ < size*size*3){
        const mv=AI.chooseMove(gg,gg.turn,0.3);
        if(mv.pass) gg.pass(gg.turn); else gg.play(mv.x,mv.y,gg.turn);
      }
      if(gg.state==='no_result'){noResult++;}
      const s=gg.score(gg.guessDeadStones());
      const area=size*size;
      if(!(s.black>=0 && s.white>=0 && s.territory.black+s.territory.white+s.dameCount<=area)) badScore++;
      totalMoves+=gg.history.length; games++;
    }catch(e){ crashes++; if(crashes===1) console.log('    ตัวอย่างข้อผิดพลาด:',e.message); }
  }
  t(`เล่นเอง ${games} เกมโดยไม่ล่ม`, crashes===0);
  t('นับแต้มได้ผลสมเหตุสมผลทุกเกม', badScore===0);
  console.log(`    (เฉลี่ย ${(totalMoves/games).toFixed(0)} ตา/เกม, ไม่มีผลแพ้ชนะ ${noResult} เกม)`);
}

console.log(`\nรวม: ผ่าน ${pass} / ล้มเหลว ${fail}`);
process.exit(fail?1:0);
