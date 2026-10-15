// Portable deterministic SAN parser regression; public synthetic fixtures only.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const home=path.join(__dirname,'fixtures/san-parser'),manifest=JSON.parse(fs.readFileSync(path.join(home,'PROVENANCE.json'),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const row of manifest.inputs){assert.equal(sha(fs.readFileSync(path.resolve(home,row.path))),row.sha256,row.path);}
const reference=process.argv[3]?path.resolve(process.argv[3]):path.join(home,'original-chess.min.cjs');
assert([path.join(home,'original-chess.cjs'),path.join(home,'original-chess.min.cjs')].includes(reference),'Explicit owned reference only');
const Old=require(reference).Chess,OldMin=require(path.join(home,'original-chess.min.cjs')).Chess;
const candidate=process.argv[2]?path.resolve(process.argv[2]):path.resolve(__dirname,'../docs/vendor/chess.min.js');
const New=require(candidate).Chess;
let comparisons=0;
function state(c){return {fen:c.fen(),board:c.board(),header:c.header(),history:c.history(),verbose:c.history({verbose:true}),legal:c.moves(),legalVerbose:c.moves({verbose:true}),pgn:c.pgn(),turn:c.turn(),check:c.in_check(),mate:c.in_checkmate(),draw:c.in_draw(),over:c.game_over()};}
function outcome(fn){try{return {value:fn()};}catch(e){return {error:e.name,message:e.message};}}
function equal(a,b,label){assert.deepEqual(a,b,label);comparisons++;}
function token(fen,move,options,mode='explicit'){
 const a=new Old(fen),b=new New(fen);equal(state(a),state(b),'before');
 equal(outcome(()=>mode==='default'?a.move(move):a.move(move,options)),outcome(()=>mode==='default'?b.move(move):b.move(move,options)),JSON.stringify({fen,move,options,mode}));
 equal(state(a),state(b),'after');equal(a.undo(),b.undo(),'undo');equal(state(a),state(b),'after undo');
}
const fens=[undefined,'4k3/P7/8/8/8/8/7p/4K3 w - - 0 1','4k3/8/8/8/8/8/p7/4K3 b - - 0 1','r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1','4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1','4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1','4k3/8/8/8/8/1N6/8/1N2K3 w - - 0 1','4r1k1/8/8/8/8/8/4N1N1/4K3 w - - 0 1'];
const odd=['g1f3','Ng1f3','Pe2-e4','Rc1c4','Qf3xf7','prefixg1f3suffix','Nbd2','N1d2','Nb1d2','O-O','O-O-O','0-0','e8=Q','e8=N','e8=R','e8=B','exd8=N','h1=Q','Kxe4N','e4','e4+?!','e4junk','nf3','Nf9','',' e4','e4 ',null,17,{},undefined];
for(const fen of fens){const legal=new Old(fen).moves();for(const move of [...legal,...odd])for(const sloppy of [false,true])token(fen,move,{sloppy});for(const move of legal.concat(odd))token(fen,move,undefined,'default');}
// Real capture promotions: all generated promotion variants must survive filtering.
for(const [fen,from,to]of [['1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1','a7','b8'],['4k3/8/8/8/8/8/p7/1R2K3 b - - 0 1','a2','b1']]){
 const legal=new Old(fen).moves({verbose:true}).filter(m=>m.from===from&&m.to===to);assert.equal(legal.length,4);assert.deepEqual(legal.map(m=>m.promotion).sort(),['b','n','q','r']);
 for(const m of legal){for(const sloppy of [false,true])token(fen,m.san,{sloppy});token(fen,m.san,undefined,'default');
  const junk='prefixP'+from+'x'+to+m.promotion.toUpperCase()+'suffix';const strict=new Old(fen),sloppy=new Old(fen);assert.equal(strict.move(junk),null);assert(sloppy.move(junk,{sloppy:true}),'Actual accepted coordinate promotion substring');for(const mode of [false,true])token(fen,junk,{sloppy:mode});
 }
}
const fullSquare='4k3/8/8/8/8/1N6/8/1N2KN2 w - - 0 1';assert(new Old(fullSquare).moves().includes('Nb1d2'),'Genuine full-square disambiguation');for(const sloppy of [false,true])token(fullSquare,'Nb1d2',{sloppy});
for(const junk of ['prefixNg1f3suffix','prefixg1f3suffix']){assert.equal(new Old().move(junk),null);assert(new Old().move(junk,{sloppy:true}),'Actual accepted coordinate substring');for(const sloppy of [false,true])token(undefined,junk,{sloppy});}
// Rejections on live histories, not reconstructed FENs with empty history.
for(const bad of ['Nxd5','Qa4','e5','Nf9','prefixNg1f3suffix',null,17,{}])for(const sloppy of [false,true]){
 const a=new Old(),b=new New();for(const san of ['e4','e5','Nf3','Nc6'])equal(a.move(san),b.move(san),'History setup');const beforeA=state(a),beforeB=state(b);equal(beforeA,beforeB,'Nonempty before');
 const oldOutcome=outcome(()=>a.move(bad,{sloppy})),newOutcome=outcome(()=>b.move(bad,{sloppy}));assert(oldOutcome.error||oldOutcome.value===null,'Explicit rejection fixture');equal(oldOutcome,newOutcome,'Nonempty rejection');equal(state(a),beforeA,'Original rejection nonmutation');equal(state(b),beforeB,'Candidate rejection nonmutation');equal(a.undo(),b.undo(),'Nonempty undo');equal(state(a),state(b),'Nonempty undo state');
}
// Seeded complete legal games cover changing legality, clocks, histories and both colors.
let rng=88391;function random(n){rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng%n;}
for(let game=0;game<12;game++){const a=new Old(),b=new New();for(let ply=0;ply<100;ply++){equal(state(a),state(b),'random state');const legal=a.moves();if(!legal.length)break;const san=legal[random(legal.length)];for(const move of [san,san+'?!',san+'invalid'])for(const sloppy of [false,true])token(a.fen(),move,{sloppy});equal(a.move(san),b.move(san),'random played');}equal(state(a),state(b),'random final');}
const pgn=fs.readFileSync(path.resolve(home,manifest.cohort),'utf8');const games=pgn.trim().split(/\r?\n\s*\r?\n(?=\[Event )/);assert.equal(games.length,15);
for(const text of games)for(const sloppy of [false,true]){
 const a=new Old(),b=new New(),m=new OldMin();const options={sloppy};equal(outcome(()=>a.load_pgn(text,options)),outcome(()=>b.load_pgn(text,options)),'PGN accept');equal(m.load_pgn(text,options),true,'old min PGN');equal(state(a),state(b),'PGN full state');equal(state(a),state(m),'original min oracle');
 const replay=new New(a.header().FEN),reference=new Old(a.header().FEN);for(const san of a.history()){equal(reference.move(san),replay.move(san),'PGN ply');equal(state(reference),state(replay),'PGN every-ply state');}
}
for(const text of ['[Event "decorations"]\n\n1. e4 {hello} e5 2.Nf3 (2.Bc4) Nc6 $1 *','[Event "bad"]\n\n1. e4 e5 2. Nonsense *','[SetUp "1"]\n[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. a8=N *'])for(const sloppy of [false,true]){const a=new Old(),b=new New();equal(outcome(()=>a.load_pgn(text,{sloppy})),outcome(()=>b.load_pgn(text,{sloppy})),'variant accept');equal(state(a),state(b),'variant state');}
// Exact baseline production helpers, not a rewritten parseGame oracle.
const vm=require('node:vm'),app=fs.readFileSync(path.join(home,'original-web-app.js'),'utf8');
const start=app.indexOf('  function inferTimeClass('),end=app.indexOf('  function branchResult(');assert(start>0&&end>start);
const primitives=app.split(/\r?\n/).filter(line=>/^  const (num|clamp) =/.test(line));assert.equal(primitives.length,2);
function parser(Chess){const ctx={Chess,state:{username:'fixture-player'}};vm.createContext(ctx);vm.runInContext(primitives.join('\n')+'\n'+app.slice(start,end)+'\nthis.parse=parseGame;',ctx);return ctx.parse;}
const parseOld=parser(Old),parseNew=parser(New),variants=[...games,
 '[Event "clocks"]\n[White "fixture-player"]\n[Black "opponent"]\n[TimeControl "300+2"]\n[Result "*"]\n\n1. e4 {[%clk 0:04:59]} e5 {[%clk 0:04:58]} 2. Nf3 {[%clk 0:04:56]} Nc6 {[%clk 0:04:55]} *',
 '[Event "annotations"]\n\n1. e4 {text} e5 (1... c5) 2. Nf3 $1 Nc6 *',
 '[Event "setup"]\n[SetUp "1"]\n[FEN "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. a8=N *',
 '[SetUp "1"]\n[FEN "not a fen"]\n\n1. e4 *','1. e4 e5 2. Nonsense *','',null];
for(const [index,pgnText]of variants.entries())for(const options of [{},{username:'fixture-player',playerColor:'white'},{username:'opponent',playerColor:'black'}]){
 const raw={pgn:pgnText,uuid:'owned-'+index,url:'https://example.invalid/owned/'+index,white:{username:'fixture-player',rating:1234},black:{username:'opponent',rating:1321},accuracies:{white:83.5,black:78.25},end_time:1700000000+index};
 equal(JSON.parse(JSON.stringify(outcome(()=>parseOld(raw,options)))),JSON.parse(JSON.stringify(outcome(()=>parseNew(raw,options)))),'Complete production parseGame record');
}
console.log(JSON.stringify({pass:true,comparisons,cohortGames:15,parseGameVariants:variants.length,seed:88391,candidate,reference,scope:'Full parser outputs/state, exact production parseGame records, deterministic legal play and strict/sloppy/default behavior; no timing claim'}));
