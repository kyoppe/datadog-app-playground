import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(join(appRoot, relativePath), 'utf8');

const config = JSON.parse(await read('datadog-app.config.json'));
assert.match(config.id, /^[0-9a-f-]{36}$/i, 'App ID must be a UUID');
assert.equal(config.name, 'Apps Intro Alternative - Under Water');

const entrypoint = await read('src/HtmlCanvasArticle.tsx');
assert.match(entrypoint, /requestPaint/);
assert.match(entrypoint, /texElementSubImage2D/);
assert.match(entrypoint, /createLiquidGlass/);
assert.match(entrypoint, /createJelly/);
assert.match(entrypoint, /createInk/);
assert.match(entrypoint, /createWater/);

for (const effect of ['water', 'liquidGlass', 'ink', 'jelly']) {
    const source = await read(`src/effects/${effect}.ts`);
    assert.match(source, /export function create/);
}

const html = await read('index.html');
assert.match(html, /id="app"/);
assert.match(html, /src="\/src\/main\.tsx"/);

console.log('Smoke test passed: App configuration and effect entrypoints are present.');
