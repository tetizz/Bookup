import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(process.argv[2] || path.join(repo, 'docs/web-app.js'));
const witnessOnly = process.argv.includes('--witness-only');
const source = fs.readFileSync(sourcePath, 'utf8');
const marker = '  document.addEventListener("DOMContentLoaded", initialize);';
assert.equal(source.split(marker).length, 2);
// Expose the original functions in a VM; never run initialization, a browser,
// network, analysis or a substitute implementation of persistence.
const instrumented = source.replace(marker,
  '  window.restoreAudit = { state, load, serializedState, applyUserWorkspace };\n' + marker);
const chess = fs.readFileSync(path.join(repo, 'docs/vendor/chess.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function boot(saved) {
  const context = vm.createContext({
    window: {}, document: { addEventListener() {} }, console,
    localStorage: { getItem() { return JSON.stringify(saved); }, removeItem() { throw Error('Unexpected storage removal'); } },
    fetch() { throw Error('Network forbidden'); },
  });
  vm.runInContext(chess, context, { filename: 'vendor/chess.js' });
  vm.runInContext(instrumented, context, { filename: sourcePath });
  context.window.restoreAudit.load();
  return { context, hooks: context.window.restoreAudit };
}
const workspace = {
  reviews: [{ lessonId: 'owned-lesson', result: 'known', due: '2099-01-01', streak: 1 }],
  sessions: [{ date: '2026-10-14', minutes: 8 }], snapshots: [{ total: 2 }],
  goalBaselines: { owned: 7 }, manualRepertoire: { fen: 'e2e4' }, stats: { known: 1 },
  accuracy: { average: 81, opening: 82, middlegame: 83, endgame: 84 },
  dropoff: [[1, 100, 50, 10, 40]], customGames: 2, projectionMode: 'simple',
};
function checkWorkspace(state, expected = workspace) {
  for (const key of Object.keys(expected)) assert.deepEqual(plain(state[key]), expected[key], key);
}
function anonymousRoundTrips() {
  let saved = { username: '', ...workspace, userWorkspaces: {} };
  for (let index = 0; index < 2; index++) {
    const { hooks } = boot(saved);
    checkWorkspace(hooks.state);
    saved = JSON.parse(hooks.serializedState());
    assert.deepEqual(saved.reviews, workspace.reviews);
  }
}
const cases = [['anonymous complete workspace survives two round trips', anonymousRoundTrips]];
if (!witnessOnly) cases.push(
  ['named workspace wins over top-level fields', () => {
    const named = { ...workspace, reviews: [{ lessonId: 'named', result: 'missed' }] };
    checkWorkspace(boot({ username: ' Named ', ...workspace, userWorkspaces: { named } }).hooks.state, named);
  }],
  ['legacy top-level workspace remains available', () => {
    const { hooks } = boot({ username: 'Legacy', ...workspace });
    checkWorkspace(hooks.state);
    assert.deepEqual(JSON.parse(hooks.serializedState()).userWorkspaces.legacy.reviews, workspace.reviews);
  }],
  ['invalid and missing current entries retain current top-level data', () => {
    for (const entry of [null, 7, 'invalid', []]) {
      checkWorkspace(boot({ username: 'named', ...workspace, userWorkspaces: { named: entry } }).hooks.state);
    }
    checkWorkspace(boot({ username: 'named', ...workspace, userWorkspaces: {} }).hooks.state);
  }],
  ['array workspace maps are rejected and current data round trips', () => {
    let saved = { username: 'named', ...workspace, userWorkspaces: [{ reviews: [] }] };
    for (let index = 0; index < 2; index++) {
      const { hooks } = boot(saved);
      assert.equal(Array.isArray(hooks.state.userWorkspaces), false);
      checkWorkspace(hooks.state);
      saved = JSON.parse(hooks.serializedState());
      assert.deepEqual(saved.userWorkspaces.named.reviews, workspace.reviews);
    }
  }],
  ['switching to a new or inherited/nonobject workspace clears explicitly', () => {
    const { context, hooks } = boot({ username: '', ...workspace, userWorkspaces: {} });
    vm.runInContext('window.restoreAudit.state.userWorkspaces = Object.create({ inherited: { reviews: [{ lessonId: "wrong" }] } });', context);
    for (const name of ['new-user', 'inherited']) {
      hooks.applyUserWorkspace(name);
      assert.deepEqual(plain(hooks.state.reviews), []);
      assert.deepEqual(plain(hooks.state.sessions), []);
      assert.deepEqual(plain(hooks.state.manualRepertoire), {});
    }
    for (const entry of [7, [], 'invalid']) {
      hooks.state.userWorkspaces.bad = entry;
      hooks.applyUserWorkspace('bad');
      assert.deepEqual(plain(hooks.state.reviews), []);
    }
  }],
);
let failures = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(JSON.stringify({ sourcePath, cases: cases.length, failures, offline: true }));
process.exitCode = failures ? 1 : 0;
