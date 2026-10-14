const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = process.env.BOOKUP_BASELINE ? cp.execFileSync('git', ['show', '307da8b:docs/web-app.js'], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'docs/web-app.js'), 'utf8');
const game = id => ({ uuid: id, time_class: 'blitz', time_control: '300', end_time: Number(id.replace(/\D/g, '')) || 1, white: { username: 'fixture', rating: 1200 }, black: { username: 'opponent' }, pgn: '[White "fixture"]\n[Black "opponent"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const calls = [], canceled = [], stored = new Map();
  const response = (payload, status = 200) => ({ ok: status === 200, status, headers: { get() { return null; } }, async json() { return payload; } });
  const context = { console, setTimeout, clearTimeout, DOMException, AbortController, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, navigator: {}, document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } }, localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) }, async fetch(url, { signal }) {
    if (url.endsWith('/stats')) return response({});
    if (url.endsWith('/archives')) return response({ archives: options.urls || ['old', 'middle', 'new'] });
    calls.push(url);
    const reply = options.month ? options.month(url) : { games: [game('g1'), game('g2')] };
    return new Promise((resolve, reject) => {
      const abort = () => { canceled.push(url); reject(new DOMException('Canceled', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(reply).then(value => { signal.removeEventListener('abort', abort); resolve(response(value, value.status || 200)); }, reject);
    });
  }};
  context.window = context;
  context.BookupPositionAnalysis = { async analyzeImportedGames() { return { lessons: [], due: [], fresh: [], known: [], candidates: 0, analyzed: 0, cacheHits: 0 }; }, async analyzeGameAccuracy(games) { return { games: games.map(g => ({ id: g.id })), summary: {} }; } };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(root, 'docs/vendor/chess.min.js'), 'utf8'), context);
  const fixtureSource = options.before ? cp.execFileSync('git', ['show', '307da8b:docs/web-app.js'], { cwd: root, encoding: 'utf8' }) : source;
  vm.runInContext(fixtureSource.replace('  document.addEventListener("DOMContentLoaded", initialize);', '  window.ArchiveFixture = { state, fetchPublicGames, fetchJson, workspaceCacheKey };'), context);
  const hook = context.ArchiveFixture; hook.state.username = 'fixture'; hook.state.settings.maxGames = options.wanted || 2; hook.state.settings.importAllGames = Boolean(options.all);
  return { ...hook, calls, canceled, run: signal => hook.fetchPublicGames(signal || new AbortController().signal) };
}
test('newest quota completes without blocked older responses, canceling both unused requests', async () => {
  const older = deferred(), f = fixture({ month: url => url === 'new' ? { games: [game('g1'), game('g2')] } : older.promise });
  let complete = false; const run = f.run().then(() => { complete = true; });
  await new Promise(done => setTimeout(done, 60));
  const beforeRelease = complete; older.resolve({ games: [game('g3')] }); await run;
  assert.equal(beforeRelease, true); assert.deepEqual(f.calls, ['new', 'middle', 'old']); assert.deepEqual(f.canceled.sort(), ['middle', 'old']);
  assert.equal(f.state.games.length, 2); assert.equal(f.state.importMeta.warnings.length, 0);
});
test('insufficient newest retains concurrent fetches and deterministic newest-first quota', async () => {
  const newest = deferred(), f = fixture({ month: url => url === 'new' ? newest.promise : { games: [game(url === 'middle' ? 'g2' : 'g3')] } });
  const run = f.run(); await new Promise(done => setTimeout(done, 10)); assert.deepEqual(f.calls, ['new', 'middle', 'old']);
  newest.resolve({ games: [game('g1')] }); await run;
  assert.deepEqual(Array.from(f.state.games, g => g.id), ['g1', 'g2']); assert.equal(f.state.importMeta.archivesScanned, 2);
});
test('complete history consumes every month in original bounded concurrent batches', async () => {
  const f = fixture({ all: true, urls: ['old', 'middle', 'new', 'latest'], month: url => ({ games: [game('g' + ({ latest: 4, new: 3, middle: 2, old: 1 }[url]))] }) });
  await f.run(); assert.deepEqual(f.calls, ['latest', 'new', 'middle', 'old']); assert.equal(f.state.games.length, 4); assert.equal(f.state.importMeta.archivesScanned, 4);
});
test('failed-archive retry is still consumed when newest already fills quota', async () => {
  const f = fixture({ month: url => url === 'old' ? { games: [], status: 404 } : { games: [game('g1'), game('g2')] } });
  f.state.cacheKey = f.workspaceCacheKey('fixture', f.state.settings); f.state.importMeta = { failedArchiveUrls: ['old'] };
  await f.run(); assert.equal(f.state.importMeta.archivesScanned, 3); assert.deepEqual(Array.from(f.state.importMeta.failedArchiveUrls), ['old']); assert.equal(f.state.importMeta.warnings.length, 1);
});
test('exact duplicate archive URLs cause one request each without losing distinct history', async () => {
  const f = fixture({ all: true, urls: ['old', 'new', 'new'], month: url => ({ games: [game(url === 'new' ? 'g2' : 'g1')] }) });
  await f.run(); assert.deepEqual(f.calls, ['new', 'old']); assert.equal(f.state.games.length, 2);
});
test('stop cancels current batch and does not commit replacement games', async () => {
  const waiting = deferred(), f = fixture({ month: () => waiting.promise }); const controller = new AbortController();
  const run = f.run(controller.signal); const rejection = assert.rejects(run, { name: 'AbortError' }); await new Promise(done => setTimeout(done, 10)); controller.abort(); await rejection;
  assert.deepEqual(f.canceled.sort(), ['middle', 'new', 'old']); assert.equal(f.state.games.length, 0); waiting.resolve({ games: [] });
});
test('already canceled fetch never starts another request', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.fetchJson('new', { signal: controller.signal }), { name: 'AbortError' }); assert.deepEqual(f.calls, []);
});
test('already observed speculative archive failure retains its retry marker and warning', async () => {
  const newest = deferred(), f = fixture({ month: url => url === 'new' ? newest.promise : url === 'old' ? { status: 404, games: [] } : { games: [] } });
  const run = f.run(); await new Promise(done => setTimeout(done, 10)); newest.resolve({ games: [game('g1'), game('g2')] }); await run;
  assert.deepEqual(Array.from(f.state.importMeta.failedArchiveUrls), ['old']); assert.equal(f.state.importMeta.warnings.length, 1); assert.equal(f.state.importMeta.archivesComplete, false);
});
test('required failed retry preserves complete game/branch results and failure metadata against pinned browser source', async () => {
  const run = async before => {
    const f = fixture({ before, month: url => url === 'old' ? { games: [], status: 404 } : { games: [game('g1'), game('g2')] } });
    f.state.cacheKey = f.workspaceCacheKey('fixture', f.state.settings); f.state.importMeta = { failedArchiveUrls: ['old'] };
    await f.run(); const { elapsedMs, completedAt, ...meta } = f.state.importMeta;
    return JSON.parse(JSON.stringify({ games: f.state.games, branches: f.state.branches, lessons: f.state.lessons, accuracy: f.state.gameAnalysis, meta }));
  };
  assert.deepEqual(await run(false), await run(true));
});