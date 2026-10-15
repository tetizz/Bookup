# Shared replay regression fixtures

Run from a normal checkout with Node: `node scripts/web_shared_replay_regression.cjs`.

The test reads only repository files. It needs no Git executable, full history, audit workspace, provider, browser, engine process or installed packages. The existing bundled Chess parser is loaded from docs/vendor/chess.min.js. The candidate production functions run in an isolated VM; all-hit engine values come from the recorded fixtures.

- baseline-position-analysis-f2b3039.js is the exact old analyzer Git blob at f2b3039d164bce42653c7c733f669a0e46e97c74. It is a frozen differential oracle, not shipped application code. Do not update it alongside the candidate to make a regression pass.
- cohort-15.pgn contains 15 owned synthetic games built from public standard opening sequences. Headers use fixture-player and public-position-opponent, not real account histories. There are 360 legal SAN plies and 180 White decisions.
- analysis-seed.json contains all 90 exact real SF18 records from the approved full-cohort primer: only board/move keys, numeric engine values, legal PVs and record timestamps. Values were not synthesized or rounded. No account data, credentials, private URLs or storage snapshots are included.
- provenance.json records original source/primer identities and raw fixture hashes. The regression checks those hashes before reading the oracle. The local .gitattributes preserves exact bytes on Windows and Linux.

The original full-output/read/progress differential, malformed-input, cancellation, disposal, selection and cap-boundary gates are unchanged. Cap tests repeat legal lines with synthetic mode labels to exercise more than 180 selected decisions; they are functional unit data, not a representative timing cohort. These fixtures establish deterministic cached behavior, not fresh engine throughput or public runtime performance.

If the contract changes intentionally, review a separate oracle/fixture update with new provenance rather than regenerate expected output from the new implementation. No fixture script fetches new data.