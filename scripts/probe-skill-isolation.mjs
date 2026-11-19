// No model turns: scratch homes, app-server skills/list, and Claude's local /skills command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { codexSkillFiles } from '../dist/core/extensions.js';
import { CLAUDE_BUILTIN_PLUGINS } from '../dist/backends/claude.js';
const disabledPlugins = Object.fromEntries(CLAUDE_BUILTIN_PLUGINS.map((name) => [`${name}@builtin`, false]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-skills-'));
const home = path.join(root, 'home');
const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (at, name) => write(path.join(at, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Scratch probe.\n---\nScratch probe.\n`);
for (const [at, name] of [[path.join(home, '.codex/skills'), 'user-probe'], [path.join(home, '.agents/skills'), 'agents-probe'], [path.join(repo, '.agents/skills'), 'repo-probe'], [path.join(home, '.claude/skills'), 'user-probe'], [path.join(repo, '.claude/skills'), 'repo-probe']]) skill(at, name);
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), TMPDIR: root, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
assert.match(spawnSync('codex', ['--version'], { env, encoding: 'utf8' }).stdout, /codex-cli 0\.163\.0\b/);
assert.match(spawnSync('claude', ['--version'], { env, encoding: 'utf8' }).stdout, /^2\.1\.302\b/);
const pkg = path.join(root, 'package');
const captured = { versions: { codex: '0.163.0', claude: '2.1.302' }, claude: [] };
skill(path.join(pkg, 'skills'), 'given-probe');
async function codex(args, extra = false) {
  const p = spawn('codex', ['--disable', 'plugins', ...args, 'app-server'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = ''; p.stderr.on('data', (b) => { err += b; });
  const waiters = new Map(); let id = 0;
  const rl = readline.createInterface({ input: p.stdout });
  rl.on('line', (line) => { try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch {} });
  const rpc = (method, params) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => reject(new Error(`${method} timed out: ${err.slice(-1000)}`)), 15000); waiters.set(n, (m) => { clearTimeout(timer); resolve(m); }); p.stdin.write(JSON.stringify({ id: n, method, params }) + '\n'); });
  try {
    await rpc('initialize', { clientInfo: { name: 'relay-probe', version: '1' }, capabilities: { experimentalApi: true } });
    if (extra) await rpc('skills/extraRoots/set', { extraRoots: [path.join(pkg, 'skills')] });
    return await rpc('skills/list', { cwds: [repo], forceReload: true });
  } finally { p.stdin.end(); p.kill('SIGTERM'); await new Promise((r) => p.once('close', r)); rl.close(); }
}
const baseline = await codex([]);
const brief = (r) => r.result?.data?.flatMap((d) => d.skills.map(({name, path, scope, enabled}) => ({name, path, scope, enabled}))) ?? r;
console.log(JSON.stringify({ root, baseline: brief(baseline) }));
const overrides = ['-c', `skills.config=[${codexSkillFiles(repo, env).map((f) => `{path=${JSON.stringify(f)},enabled=false}`).join(',')}]`];
for (const extra of [false, true]) {
  const result = await codex(overrides, extra);
  const skills = brief(result);
  assert.deepEqual(skills.filter((s) => s.enabled).map((s) => s.name), extra ? ['given-probe'] : []);
  captured[extra ? 'codexGiven' : 'codexEmpty'] = { data: [{ cwd: repo, skills, errors: result.result.data[0].errors }] };
  console.log(JSON.stringify({ [extra ? 'given' : 'disabled']: skills }));
}
write(path.join(pkg, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'relay-skills' }));
for (const sources of ['', 'user,project,local']) {
  for (const settings of [{}, { disableBundledSkills: true, skillOverrides: { 'user-probe': 'off', 'repo-probe': 'off', doctor: 'off', 'plugin-authoring': 'off' }, enabledPlugins: disabledPlugins }]) {
    const r = spawnSync('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', sources, '--settings', JSON.stringify(settings), '/skills'], { cwd: repo, env, encoding: 'utf8', timeout: 25000 });
    const init = r.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.subtype === 'init');
    assert.ok(init, r.stderr);
    if (settings.disableBundledSkills) assert.deepEqual(init.skills, []);
    captured.claude.push({ sources, settings, init: { skills: init.skills, plugins: init.plugins } });
    console.log(JSON.stringify({ claude: { sources, settings, status: r.status, error: r.error?.message, init: init && { skills: init.skills, plugins: init.plugins }, stderr: r.stderr.slice(-1000) } }));
  }
}
const settings = { disableBundledSkills: true, skillOverrides: { doctor: 'off', 'plugin-authoring': 'off' }, enabledPlugins: disabledPlugins };
const given = spawnSync('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--settings', JSON.stringify(settings), '--plugin-dir', pkg, '/skills'], { cwd: repo, env, encoding: 'utf8', timeout: 25000 });
const givenInit = given.stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.subtype === 'init');
assert.ok(givenInit, given.stderr);
assert.deepEqual(givenInit.skills, ['relay-skills:given-probe']);
captured.claudeGiven = { skills: givenInit.skills, plugins: givenInit.plugins };
console.log(JSON.stringify({ claudeGiven: captured.claudeGiven }));
const output = process.argv.indexOf('--out');
if (output !== -1) {
  // Selected native reply fields, with only scratch path prefixes normalized for replay.
  const normalize = (text) => text.replaceAll(fs.realpathSync(root), '@ROOT@').replaceAll(root, '@ROOT@');
  fs.writeFileSync(process.argv[output + 1], normalize(JSON.stringify(captured, null, 2)) + '\n');
}
