import 'dotenv/config';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const schema = `kuvi_meds_test_${randomUUID().replaceAll('-', '')}`;
const original = process.env.DATABASE_URL;
if (!original) throw new Error('DATABASE_URL is required');
const url = new URL(original);
url.searchParams.set('schema', schema);
const env = { ...process.env, DATABASE_URL: url.toString(), MEDICATION_TEST_SCHEMA: schema };
const client = new Client({ connectionString: original });
await client.connect();
try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  for (const [command, args] of [
    ['node_modules/.bin/prisma', ['migrate', 'deploy']],
    ['node_modules/.bin/tsc', []],
    [process.execPath, ['--test', 'tests/medications.test.mjs']],
  ]) {
    const result = spawnSync(command, args, { env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
  }
} finally {
  await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  await client.end();
}
