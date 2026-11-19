import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const requiredFiles = [
    'datadog-app.config.json',
    'index.html',
    'src/main.tsx',
    'src/TimeseriesAlternative.tsx',
    'src/metrics.backend.ts',
    'src/metricSearch.backend.ts',
    'src/bars/barRenderer.ts',
    'src/bars/glUtils.ts',
    'src/sound.ts',
];

const missingFiles = requiredFiles.filter((file) => !existsSync(join(appRoot, file)));
if (missingFiles.length > 0) {
    throw new Error(`Missing required app files: ${missingFiles.join(', ')}`);
}

const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
if (packageJson.scripts?.test !== 'node scripts/smoke-test.mjs') {
    throw new Error('The test script is not configured correctly.');
}

const config = JSON.parse(readFileSync(join(appRoot, 'datadog-app.config.json'), 'utf8'));
if (config.name !== 'Timeseries Alternative' || !config.id) {
    throw new Error('The Datadog App configuration is incomplete.');
}

console.log('Smoke test passed: App configuration and entrypoints are present.');
