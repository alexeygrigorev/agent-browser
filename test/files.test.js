import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFiles } from '../src/files.js';

async function fixture(t, maxBytes) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, files: createFiles({ directory, maxBytes }) };
}
test('stages binary uploads with unique destinations and preserved filenames', async t => {
  const { files } = await fixture(t);
  const data = Buffer.from([0, 1, 255, 127]);
  const first = await files.stage(Readable.from([data.subarray(0, 2), data.subarray(2)]), 'données.csv');
  const second = await files.stage(Readable.from([data]), 'données.csv');
  assert.notEqual(first.path, second.path);
  assert.equal(first.name, 'données.csv');
  assert.equal(first.size, 4);
  assert.deepEqual(await readFile(first.path), data);
  await files.validate([first.path, second.path]);
});
test('rejects portable path traversal and invalid filenames before creating files', async t => {
  const { files, directory } = await fixture(t);
  for (const name of ['../secret', 'C:\\file', 'nested/file', '', null, 'NUL.txt', 'trailing.']) await assert.rejects(files.stage(Readable.from(['test']), name));
  assert.deepEqual(await readdir(directory), []);
});
test('oversized or interrupted uploads are removed', async t => {
  const { files, directory } = await fixture(t, 3);
  await assert.rejects(files.stage(Readable.from(['four']), 'big.txt'), error => error.statusCode === 413);
  assert.deepEqual(await readdir(directory), []);
  async function* broken() { yield 'ok'; throw new Error('source interrupted'); }
  await assert.rejects(files.stage(Readable.from(broken()), 'partial.txt'), /interrupted/);
  assert.deepEqual(await readdir(directory), []);
});
test('validates absolute regular files and rejects missing files or directories', async t => {
  const { files, directory } = await fixture(t);
  const path = join(directory, 'valid.txt'); await writeFile(path, 'contents');
  await files.validate([path]);
  await assert.rejects(files.validate(['relative.txt']), /absolute/);
  await assert.rejects(files.validate([directory]), /regular/);
  await assert.rejects(files.validate([join(directory, 'missing.txt')]));
});
