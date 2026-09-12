'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Extract readError() from scripts.ejs and exercise it directly, so the client
// guard is covered rather than assumed.
const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'dashboard', 'scripts.ejs'), 'utf8');
const start = source.indexOf('async function readError(');
assert.ok(start > -1, 'readError() should exist in scripts.ejs');
const end = source.indexOf('\n        }', source.indexOf('} catch (e) {', start)) + '\n        }'.length;
const fnSource = source.slice(start, end);

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${fnSource}; this.readError = readError;`, sandbox);
const { readError } = sandbox;

const fakeResponse = (body) => ({ text: async () => body });

test('reads the message out of a JSON error body', async () => {
    const msg = await readError(fakeResponse(JSON.stringify({ error: 'Insufficient balance.' })));
    assert.strictEqual(msg, 'Insufficient balance.');
});

test('falls back to plain text bodies', async () => {
    assert.strictEqual(await readError(fakeResponse('Daily limit exceeded.')), 'Daily limit exceeded.');
});

test('never returns markup from an HTML error page', async () => {
    const html = '<!DOCTYPE html><html lang="en"><head><title>Error</title></head><body><pre>Cannot POST /portal/x</pre></body></html>';
    const msg = await readError(fakeResponse(html));
    assert.doesNotMatch(msg, /[<>]/, 'markup must be stripped');
    assert.match(msg, /Cannot POST/, 'the useful text should survive');
});

test('uses the fallback for an empty body', async () => {
    assert.strictEqual(await readError(fakeResponse(''), 'Fallback msg'), 'Fallback msg');
});

test('uses the fallback when the body cannot be read', async () => {
    const broken = { text: async () => { throw new Error('network gone'); } };
    assert.strictEqual(await readError(broken, 'Fallback msg'), 'Fallback msg');
});

test('uses the fallback for JSON without an error field', async () => {
    assert.strictEqual(await readError(fakeResponse('{"ok":false}'), 'Fallback msg'), 'Fallback msg');
});

test('collapses whitespace and truncates very long messages', async () => {
    const long = 'x'.repeat(500);
    const msg = await readError(fakeResponse(JSON.stringify({ error: long })));
    assert.ok(msg.length <= 201, `message should be truncated, got ${msg.length}`);
    assert.match(msg, /…$/);
});

test('handles a bare HTML fragment with no text content', async () => {
    const msg = await readError(fakeResponse('<div></div>'), 'Fallback msg');
    assert.strictEqual(msg, 'Fallback msg');
});
