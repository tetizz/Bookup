const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'docs/web-app.js'),'utf8');
const pgn='[Event "Public inert completion fixture"]\n[White "fixture"]\n[Black "opponent"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1';
function fixture({backupFails=false,primaryFails=false}={}){
 const events=[],timers=new Map(),idle=[],stored=new Map();let timerId=0,pendingPut;
 const node=()=>({textContent:'',innerHTML:'',dataset:{},style:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},focus(){}});
 const nodes=new Map(['progressLabel','status','pgnImportStatus','chessnutImportStatus'].map(id=>[id,node()]));
 const db={
  objectStoreNames:{contains(){return true}},
  close(){},
  transaction(){
   return {
    objectStore(){
     return {
      put(record){
       events.push('primary-put');
       const request={};
       pendingPut=()=>{
        if(primaryFails){request.error=Error('primary failed');request.onerror()}
        else{events.push('primary-success');request.onsuccess()}
       };
       return request;
      }
     };
    }
   };
  }
 };
 const context={console,DOMException,AbortController,navigator:{},setTimeout(fn,delay){if(delay===0){queueMicrotask(fn);return ++timerId}timers.set(++timerId,{fn,delay});return timerId},clearTimeout(id){timers.delete(id)},requestAnimationFrame(){},cancelAnimationFrame(){},requestIdleCallback(fn){idle.push(fn)},indexedDB:{open(){const request={result:db};queueMicrotask(()=>request.onsuccess());return request}},document:{body:{classList:{add(){},remove(){}}},addEventListener(){},getElementById:id=>nodes.get(id)||null,querySelectorAll(){return []}},localStorage:{getItem:key=>stored.get(key)||null,setItem(key,value){events.push('backup-put');if(backupFails)throw Error('quota');stored.set(key,value)}},async fetch(url){return{ok:true,status:200,headers:{get(){return null}},async json(){return url.endsWith('/stats')?{}:url.endsWith('/archives')?{archives:['public-month']}:{games:[{uuid:'public-game',time_class:'blitz',time_control:'300',white:{username:'fixture'},black:{username:'opponent'},pgn}]}}}}};context.window=context;
 context.BookupPositionAnalysis={async analyzeImportedGames(){return{lessons:[{lessonId:'current',lineStatus:'needs_work',repeatMistakeCount:2,classification:{key:'blunder'},recommendedMove:'e3',yourRepeatedMove:'g4',color:'white',frequency:2,priority:1}],due:[{}],fresh:[],known:[],candidates:1,analyzed:0,cacheHits:1}},async analyzeGameAccuracy(){return{games:[{id:'current-analysis'}],summary:{},cacheHits:1,analyzed:0}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'docs/vendor/chess.min.js'),'utf8'),context);
 vm.runInContext(source.replace('  document.addEventListener("DOMContentLoaded", initialize);','  window.CompletionFixture = {state, importPgnText, refreshAll, save, backupWarning};'),context);
 return{...context.CompletionFixture,events,nodes,stored,timers,idle,async releasePrimary(){for(let i=0;i<100&&!pendingPut;i++)await Promise.resolve();assert(pendingPut,'primary write reached: '+nodes.get('status').textContent+' '+JSON.stringify(events));assert(!events.includes('backup-put'));pendingPut()}};
}
(async()=>{
 for(const publicImport of [false,true])for(const backupFails of [false,true]){
  console.log('SCENARIO',publicImport?'public':'PGN',backupFails?'backup failure':'backup success');const f=fixture({backupFails});f.state.username='fixture';const task=publicImport?f.refreshAll():f.importPgnText(pgn);task.catch(error=>console.error('Import failed before persistence:',error));await f.releasePrimary();const result=await task;
  assert(f.events.indexOf('backup-put')>f.events.indexOf('primary-success'));assert.equal(f.state.lessons[0].lessonId,'current');assert.equal(f.state.games.length,1);assert(![...f.timers.values()].some(timer=>timer.delay===120));
  if(!publicImport)assert.equal(result.backupSaved,!backupFails);
  if(backupFails){assert.equal(f.stored.size,0);assert(f.nodes.get('status').textContent.includes('backup could not be updated'))}
  else{const backup=JSON.parse([...f.stored.values()][0]);assert.equal(backup.lessons[0].lessonId,'current');assert.equal(backup.gameAnalysis[0].id,'current-analysis')}
 }
 const failed=fixture({primaryFails:true});const run=failed.importPgnText(pgn);await failed.releasePrimary();await assert.rejects(run,/primary failed/);assert.equal(failed.state.games.length,0);assert(!failed.events.includes('backup-put'));
 const ordinary=fixture();ordinary.save();assert.equal(ordinary.events.length,0);assert.equal(ordinary.timers.size,1);const timer=[...ordinary.timers.values()][0];assert.equal(timer.delay,120);timer.fn();assert.equal(ordinary.events.length,0);assert.equal(ordinary.idle.length,1);ordinary.idle[0]();assert(ordinary.events.includes('backup-put'));
 console.log('PASS real PGN/public completion order, nonfatal backup failure, primary failure rollback, unchanged edit debounce');
})().catch(e=>{console.error(e);process.exitCode=1});
