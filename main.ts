// token-radar-01 entrypoint (Node 22, standard library only).
//
// Pipeline: load the sealed DefiLlama snapshot, score it with the comparables
// model in lib/model.ts, then emit everything the grader expects into the
// output directory — board.json, the dashboard bundle with its data file, the
// screenshots, and finally dossier.json, which the vendored library builds
// from the finished output tree.
//
// Usage: node main.ts [--input <snapshot.json|dir>] [--output <dir>]
// Defaults follow the grader's container: input /input, output /output; the
// MAKEFUN_OUTPUT_DIR environment variable overrides the output default.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

function fail(message: string, code: number): never {
  process.stderr.write(`token-radar: ${message}\n`);
  process.exit(code);
}

/** Value of `--flag <value>` or `--flag=<value>` in argv, else the fallback. */
function flagValue(flag: string, fallback: string): string {
  const prefix = `--${flag}=`;
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i]!;
    if (arg === `--${flag}` && i + 1 < process.argv.length) return process.argv[i + 1]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

// --- locate the snapshot ---------------------------------------------------
const inputArg = flagValue('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`no snapshot found at ${snapshotPath} — pass --input or mount the sealed /input`, 2);
}
const outputDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// --- run the model -----------------------------------------------------------
const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) fail(`the model produced a board the gate refuses: ${problem}`, 1);

// --- write the board and the dashboard's data --------------------------------
mkdirSync(outputDir, { recursive: true });
const boardJson = JSON.stringify({ rows: board });
writeFileSync(join(outputDir, 'board.json'), `${boardJson}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

// --- copy the dashboard and the screenshots ----------------------------------
function copyFolder(source: string, target: string): string[] {
  if (!existsSync(source)) return [];
  mkdirSync(target, { recursive: true });
  const names: string[] = [];
  for (const entry of readdirSync(source)) {
    if (entry.startsWith('.')) continue;
    const from = join(source, entry);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(target, entry));
    names.push(entry);
  }
  return names;
}

copyFolder(join(repoDir, 'dashboard'), join(outputDir, 'dashboard'));
const shotNames = copyFolder(join(repoDir, 'screenshots'), join(outputDir, 'screenshots'));
if (shotNames.length < 3) {
  fail(`screenshots/ holds ${shotNames.length} file(s); the entry needs 3: board, detail, filtered`, 1);
}
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shotNames) {
  if (!SHOT_NAME.test(name)) fail(`screenshots/${name}: illegal file name for a dossier image`, 1);
}

// --- dossier last, built from the completed output tree ----------------------
const dossier = buildDossier(outputDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);

process.stdout.write(
  `token-radar: ${snapshot.protocols.length} protocols scanned, ` +
    `${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked ` +
    `(${radar.early_size} early, ${radar.live_size} already tokenized, set aside)\n`,
);
process.stdout.write(
  `token-radar: wrote board.json, data.js, dashboard/, screenshots/ (${shotNames.length} images) and dossier.json to ${outputDir}\n`,
);
