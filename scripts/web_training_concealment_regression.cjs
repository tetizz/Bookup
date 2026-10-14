const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const root=path.resolve(__dirname,'..'),nodes=new Map(),timers=[];
function node(){return {textContent:'',innerHTML:'',dataset:{},style:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){},getAttribute(){return null},replaceChildren(){this.innerHTML=''},focus(){},querySelectorAll(){return []},contains(){return false}}}
const ids=['boardTitle','boardSummary','boardLine','trainerFeedback','trainerDecision','trainerCoach','studyMoveMeta','studyMoveClassifications','trainerInsight','studyAnalysisMeta','studyEngineLines','studyDatabaseMoves','boardArrows'];for(const id of ids)nodes.set(id,node());
const context={console,DOMException,AbortController,navigator:{},setTimeout:f=>{timers.push(f);return timers.length},clearTimeout(){},requestAnimationFrame(){},cancelAnimationFrame(){},localStorage:{getItem(){return null},setItem(){}},document:{addEventListener(){},getElementById:id=>nodes.get(id)||null,querySelectorAll(){return []}},__BOOKUP_TEST__:true};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'docs/vendor/chess.min.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(root,'docs/web-app.js'),'utf8'),context);const h=context.BookupTrainerTestHooks,s=h.state;
const lesson={lessonId:'saved',decisionFen:new context.Chess().fen(),color:'white',trainingLineUci:['e2e3','e7e5','d2d4'],recommendedMoveUci:'e2e3',recommendedMove:'e3',yourRepeatedMove:'f3',continuationSan:'e3 e5 d4',lineStatus:'needs_work',repeatMistakeCount:2,classification:{key:'blunder',label:'Blunder'},frequency:2,valueLostCp:99931};s.lessons=[lesson];
h.openLesson('saved');
function concealed(){assert(!/\be3\b|\bd4\b|e2e3/.test([...nodes.values()].map(n=>n.textContent+' '+n.innerHTML).join(' ')));assert.equal(nodes.get('boardArrows').innerHTML,'');}
concealed();assert(!/e3|d4/.test(h.lessonCard(lesson)));assert(/mate-related/.test(nodes.get('trainerCoach').textContent));
s.localEngineLines=[{scoreCp:20,mate:null,pv:['e2e4','e7e5']}];h.renderPositionData();h.renderTrainerArrows();concealed();assert.equal(lesson.trainingLineUci[0],'e2e3');
h.clickSquare('e2');h.clickSquare('e4');assert.equal(s.trainer.chess.fen(),lesson.decisionFen);assert.equal(s.trainer.mistakes,1);assert(/Try e3/.test(nodes.get('trainerFeedback').textContent));
h.openLesson('saved');h.clickSquare('e2');h.clickSquare('e3');assert.equal(s.trainer.cursor,1);h.playOpponentMoves();assert.equal(s.trainer.cursor,2);assert(!/d4/.test(nodes.get('trainerDecision').textContent+nodes.get('boardLine').textContent));h.clickSquare('d2');h.clickSquare('d4');assert.equal(s.reviews.at(-1).result,'known');
h.openLesson('saved');h.clickSquare('e2');h.clickSquare('e4');h.clickSquare('e2');h.clickSquare('e3');h.playOpponentMoves();h.clickSquare('d2');h.clickSquare('d4');assert.equal(s.reviews.at(-1).result,'missed');assert.equal(s.reviews.at(-1).streak,0);
assert.equal(h.lineScore({mate:0,scoreCp:-100000}),'#0');assert.equal(h.lineScore({mate:-2},'b'),'#2');assert.equal(h.lineScore({scoreCp:31}),'+0.31');assert.equal(h.lessonLossText({valueLostCp:31}),'about 0.31 pawns lost');assert.equal(h.lessonLossText({evaluation:{played:{mate:-1}},valueLostCp:99931}),'allows forced mate');
vm.runInContext(fs.readFileSync(path.join(root,'docs/position-analysis.js'),'utf8'),context);
const typed=context.BookupPositionAnalysisTestHooks.createLesson({fen:lesson.decisionFen,key:'position',color:'white',playerMoves:new Map([['f2f3',2]]),playerSan:new Map([['f2f3','f3']]),occurrences:2,introSan:[],introUci:[],results:{}},[{scoreCp:31,mate:null,pv:['e2e3']}],{scoreCp:-99999,mate:-1,pv:['f2f3']});
assert.equal(typed.evaluation.played.mate,-1);assert.equal(typed.recommendedMoveUci,'e2e3');assert.equal(typed.valueLostCp,100030);assert.equal(typed.classification.key,'blunder');
(async()=>{
let resolve; const result=new Promise(r=>resolve=r);
context.BookupPositionAnalysis={BrowserStockfish:class {async initialize(){} analyze(){return result} close(){}}};
h.openLesson('saved'); h.clickSquare('e2'); h.clickSquare('e4');
const pending=h.requestPositionData(); await Promise.resolve(); await Promise.resolve();
h.openLesson('saved'); resolve([{scoreCp:20,pv:['e2e4']}]); await pending; concealed();
assert.equal(lesson.trainingLineUci[0],'e2e3');
console.log('PASS production open/render/late-result display/grading/reply/restart/review and score formatting');
})().catch(e=>{console.error(e);process.exitCode=1});
