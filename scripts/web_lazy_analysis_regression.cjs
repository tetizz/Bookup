const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const baseline=cp.execFileSync('git',['show','a1e100d:docs/position-analysis.js'],{cwd:root,encoding:'utf8'});
const candidate=fs.readFileSync(path.join(root,process.argv[2]||'docs/position-analysis.js'),'utf8');
const chessSource=fs.readFileSync(path.join(root,'docs/vendor/chess.min.js'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
const games=[1,2].map(i=>({id:`saved-public-fixture-${i}`,headers:{White:'fixture-player',Black:'public-opponent',Result:'0-1',TimeControl:'300'},moves:['f3','e5','g4','Qh4#'],color:'white',outcome:'loss',rating:1200,timeClass:'blitz',endTime:1700000000+i}));
async function run(source,phase,{cache=new Map(),cacheMode='all',fault='',absentCache=false,empty=false}={}){
 const workers=[],writes=[],reads=[],progress=[],controller=new AbortController();let context,readCount=0;
 class Worker {
  constructor(url){this.url=url;this.events={};this.commands=[];this.terminations=0;workers.push(this)}
  addEventListener(type,fn){(this.events[type]??=[]).push(fn)}
  emit(type,value){for(const fn of this.events[type]||[])fn(type==='message'?{data:value}:{message:value})}
  postMessage(command){this.commands.push(command);if(command.startsWith('position fen '))this.fen=command.slice(13);
   queueMicrotask(()=>{if(this.terminations)return;
    if(command==='uci'){
     if(fault==='timeout-init')return;
     if(fault==='abort-init')return controller.abort();
     if(fault==='error-init')return this.emit('error','fixture init failure');
     this.emit('message','uciok');
    }else if(command==='isready')this.emit('message','readyok');
    else if(command.startsWith('go ')){
     if(fault==='timeout-search')return;
     if(fault==='abort-search')return controller.abort();
     if(fault==='error-search')return this.emit('error','fixture search failure');
     const chess=new context.Chess(this.fen),legal=chess.moves({verbose:true}).map(m=>m.from+m.to+(m.promotion||'')).sort();
     const only=command.match(/ searchmoves (\S+)/)?.[1];const choices=only?[only]:legal.slice(0,3);
     choices.forEach((uci,i)=>this.emit('message',`info depth 3 multipv ${i+1} score cp ${only?10:100-i*30} pv ${uci}`));
     this.emit('message',`bestmove ${choices[0]}`);
    }
   });
  }
  terminate(){this.terminations++}
 }
 context={console,Worker,DOMException,AbortController,setTimeout:(fn,ms)=>setTimeout(fn,fault.startsWith('timeout')&&ms>=20000?1:ms),clearTimeout};context.window=context;vm.createContext(context);vm.runInContext(chessSource,context);vm.runInContext(source,context);
 if(fault==='abort-before')controller.abort();
 const options={signal:controller.signal,moveTimeMs:120,gamesPerMode:5,maxMoves:180,onProgress:value=>{progress.push(copy(value));if(fault==='error-progress')throw Error('fixture progress failure')}};
 if(!absentCache){options.readCache=async key=>{reads.push(key);readCount++;if(fault==='error-read')throw Error('fixture read failure');if(fault==='abort-cache')controller.abort();if(cacheMode==='none'||cacheMode==='mixed'&&readCount%2===0)return null;return cache.has(key)?copy(cache.get(key)):null};options.writeCache=async(key,value)=>{if(fault==='error-write')throw Error('fixture write failure');writes.push([key,copy(value)]);cache.set(key,copy(value))}}
 let output,error;try{output=copy(await context.BookupPositionAnalysis[phase](empty?[]:copy(games),options))}catch(e){error={name:e.name,message:e.message}}
 return{output,error,progress,workers:workers.map(w=>({url:w.url,commands:w.commands,terminations:w.terminations})),writes,reads};
}
(async()=>{
 for(const phase of ['analyzeImportedGames','analyzeGameAccuracy']){
  const evidence=new Map();const seed=await run(baseline,phase,{cache:evidence,cacheMode:'none'});assert.equal(seed.error,undefined);assert(evidence.size>0);
  const before=await run(baseline,phase,{cache:new Map(evidence)}),after=await run(candidate,phase,{cache:new Map(evidence)});
  assert.equal(before.workers.length,1);assert.equal(after.workers.length,0);assert.deepEqual(after.output,before.output);assert.deepEqual(after.writes,before.writes);assert.deepEqual(after.reads,before.reads);assert.deepEqual(after.progress,before.progress);assert.equal(after.output.analyzed,0);
  for(const scenario of [{cacheMode:'none'},{cacheMode:'mixed'},{absentCache:true}]){
   const b=await run(baseline,phase,{cache:new Map(evidence),...scenario}),a=await run(candidate,phase,{cache:new Map(evidence),...scenario});
   assert.equal(a.error,undefined);assert.deepEqual(a.output,b.output);assert.deepEqual(a.writes,b.writes);assert.deepEqual(a.reads,b.reads);assert.deepEqual(a.workers,b.workers);assert.deepEqual(a.progress,b.progress);
  }
  for(const fault of ['abort-before','abort-cache','abort-init','abort-search','error-init','error-search','timeout-init','timeout-search','error-read','error-write','error-progress']){
   const a=await run(candidate,phase,{cacheMode:'none',fault});assert(a.error,`${phase} ${fault} should fail`);assert.equal(a.error.name,fault.startsWith('abort')?'AbortError':'Error');assert(a.workers.every(w=>w.terminations>0),`${phase} ${fault} cleanup`);
   assert.equal(a.workers.length,['abort-before','error-read'].includes(fault)?0:1,`${phase} ${fault} worker path reached`);
   if(fault.endsWith('-init'))assert(a.workers[0].commands.includes('uci'),`${phase} ${fault} initialization reached`);
   if(fault.endsWith('-search'))assert(a.workers[0].commands.some(command=>command.startsWith('go ')),`${phase} ${fault} search reached`);
  }
  const empty=await run(candidate,phase,{empty:true});assert.equal(empty.workers.length,0);assert.equal(empty.error,undefined);
  const cacheAbort=await run(candidate,phase,{cache:new Map(evidence),fault:'abort-cache'});assert.equal(cacheAbort.workers.length,0);assert.equal(cacheAbort.error?.name,'AbortError');
  console.log(`PASS ${phase}: all-hit exact full output/zero workers; mixed/miss/absent same commands/results/writes; abort/error cleanup`);
 }
})().catch(e=>{console.error(e);process.exitCode=1});
