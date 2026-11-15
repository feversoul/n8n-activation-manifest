import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { apply, request } from '../apply-manifest.mjs';

async function serve(t, handle) {
  const server = createServer((req, res) => {
    req.on('end', () => handle(req, res));
    req.resume();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a read can recover after a dropped connection', async (t) => {
  let reads = 0;
  const url = await serve(t, (req, res) => {
    if (++reads === 1) req.socket.destroy();
    else res.end('ready');
  });
  assert.equal(await (await request(url)).text(), 'ready');
  assert.equal(reads, 2);
});

for (const committed of [true, false]) {
  test(`lost publish response with ${committed ? 'a committed' : 'no committed'} write`, async (t) => {
    let writes = 0;
    let live = false;
    const url = await serve(t, (req, res) => {
      if (req.method === 'POST') {
        writes++;
        if (writes === 1) {
          if (committed) live = true;
          req.socket.destroy();
        } else {
          live = true;
          res.end('{}');
        }
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'w', name: 'Example', active: live, versionId: 'v1', activeVersionId: live ? 'v1' : null }] }));
    });

    const result = await apply({
      manifest: { environments: ['test'], default: 'ignore', workflows: { w: { test: 'active' } } },
      env: 'test', url, apiKey: 'local-fixture',
    });
    assert.equal(writes, 1, 'each apply sends at most one publish');
    assert.equal(result.ok, false, 'a lost response is not a success receipt');
    assert.equal(result.rows[0].after.active, committed, 'report retains the observed state');
    assert.match(result.rows[0].error, /write outcome unknown; not retried/);
  });
}
