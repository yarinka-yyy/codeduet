import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageFiles, packageSkill } from '../tools/package.mjs';

function fixture(t) {
  const temporary = realpathSync(tmpdir()), root = mkdtempSync(join(temporary, 'duet-package-'));
  t.after(() => { assert.ok(resolve(root).startsWith(temporary + sep)); rmSync(root, { recursive: true }); });
  const parent = join(root, 'package space & test'); mkdirSync(parent);
  return { root, destination: join(parent, 'code-duet') };
}

function markdownAnchors(content) {
  const counts = new Map(), anchors = [];
  for (const [, heading] of content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = heading.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim()
      .replace(/\s+/g, '-').replace(/-+/g, '-');
    const count = counts.get(base) ?? 0; counts.set(base, count + 1);
    anchors.push(count ? base + '-' + count : base);
  }
  return anchors;
}

test('portable copy contains only allowed files and all local Markdown links resolve inside it', t => {
  const f = fixture(t); assert.equal(packageSkill(f.destination).kind, 'packaged');
  const copied = readdirSync(f.destination, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => relative(f.destination, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  assert.deepEqual(copied.sort(), [...packageFiles].sort());
  assert.ok(!existsSync(join(f.destination, '.git')) && !existsSync(join(f.destination, 'tests')));
  for (const file of copied.filter(file => file.endsWith('.md'))) {
    const content = readFileSync(join(f.destination, file), 'utf8');
    for (const [, target] of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(target)) continue;
      const [fileTarget, fragment] = target.split('#', 2);
      const resolved = fileTarget ? resolve(f.destination, file, '..', fileTarget) : join(f.destination, file);
      const rel = relative(f.destination, resolved);
      assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), target);
      assert.ok(existsSync(resolved), file + ': ' + target);
      if (fragment !== undefined) {
        const referenced = readFileSync(resolved, 'utf8');
        assert.ok(markdownAnchors(referenced).includes(decodeURIComponent(fragment)), file + ': missing anchor ' + target);
      }
    }
  }
});

test('copied CLI runs independently and missing registration fails without creating binding state', t => {
  const f = fixture(t); packageSkill(f.destination);
  const emptyHome = join(f.root, 'empty-user'); mkdirSync(emptyHome);
  const result = spawnSync(process.execPath, [join(f.destination, 'helper', 'cli.mjs'), 'inspect'],
    { cwd: f.root, env: { ...process.env, USERPROFILE: emptyHome, HOME: emptyHome }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1, result.error?.message);
  const outcome = JSON.parse(result.stderr.trim());
  assert.equal(outcome.kind, 'stopped'); assert.equal(outcome.error, 'Missing or invalid engine registration');
  assert.equal(outcome.retried, false); assert.equal(outcome.live.verified, false);
  assert.equal(outcome.snapshotOnly, true);
  assert.ok(!existsSync(join(emptyHome, '.local', 'state', 'code-duet')));
});

test('packager refuses overwrite, relative paths and destinations inside its own source', t => {
  const f = fixture(t); mkdirSync(f.destination);
  const sentinel = join(f.destination, 'owner.txt'); writeFileSync(sentinel, 'OWNER');
  assert.throws(() => packageSkill(f.destination), /exists/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'OWNER');
  assert.throws(() => packageSkill('relative/code-duet'), /absolute/);
  const source = fileURLToPath(new URL('../', import.meta.url));
  assert.throws(() => packageSkill(join(source, 'code-duet')), /outside/);
  assert.ok(!existsSync(join(source, 'code-duet')));
});

test('a portable package can reproduce itself through the same CLI in a path with spaces and ampersand', t => {
  const f = fixture(t); packageSkill(f.destination);
  const secondParent = join(f.root, 'second & copy'); mkdirSync(secondParent);
  const second = join(secondParent, 'code-duet');
  const result = JSON.parse(execFileSync(process.execPath, [join(f.destination, 'tools', 'package.mjs'), second],
    { cwd: f.root, encoding: 'utf8', windowsHide: true }));
  assert.equal(result.kind, 'packaged');
  for (const file of packageFiles) assert.deepEqual(readFileSync(join(second, file)), readFileSync(join(f.destination, file)));
});
