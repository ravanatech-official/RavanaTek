import assert from 'node:assert/strict';
import { cp, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public-build');
const require = createRequire(import.meta.url);
for (const dependency of ['express', 'compression', 'tsx']) {
  try {
    require.resolve(dependency);
  } catch {
    throw new Error(`Required security test dependency "${dependency}" is missing. Run npm ci before this test.`);
  }
}

const servers = [];
const tempDirs = [];

async function createSandbox({ includeDatabase = true } = {}) {
  const sandbox = await mkdtemp(path.join(root, 'test', '.public-security-sandbox-'));
  tempDirs.push(sandbox);
  await cp(publicDir, path.join(sandbox, 'public-build'), { recursive: true });
  await copyFile(path.join(root, 'server.js'), path.join(sandbox, 'server.js'));
  await copyFile(path.join(root, 'server.ts'), path.join(sandbox, 'server.ts'));

  const fixture = 'SYNTHETIC_PRIVATE_FIXTURE_ONLY';
  const privateFixturePaths = [
    'data/leads-db.json', 'package.json', '.env', '.git/HEAD',
    'firebase-init.js', 'firebase-applet-config.json', 'vite.config.ts',
    'metadata.json', 'src/types.ts', 'assets/server.js', 'assets/data/leads-db.json',
    'assets/.git/HEAD', 'assets/js/.git/HEAD', 'assets/js/package.json',
    'assets/js/server.js', 'assets/js/data/leads-db.json',
    'assets/css/server.js', 'assets/img/data/leads-db.json',
  ];
  for (const relativePath of privateFixturePaths) {
    if (relativePath === 'data/leads-db.json' && !includeDatabase) continue;
    const fixturePath = path.join(sandbox, relativePath);
    await mkdir(path.dirname(fixturePath), { recursive: true });
    const contents = relativePath === 'data/leads-db.json'
      ? JSON.stringify({ inquiries: [{ marker: fixture }] })
      : relativePath === 'package.json'
        ? JSON.stringify({ name: 'synthetic-private-fixture', type: 'module', marker: fixture })
      : fixture;
    await writeFile(fixturePath, contents, 'utf8');
  }
  return { sandbox, databaseFile: path.join(sandbox, 'data', 'leads-db.json'), marker: fixture };
}

async function startJavaScriptServer() {
  const fixture = await createSandbox();
  const previousDbFile = process.env.LEADS_DB_FILE;
  process.env.LEADS_DB_FILE = fixture.databaseFile;
  let app;
  try {
    ({ app } = await import(`${pathToFileURL(path.join(fixture.sandbox, 'server.js')).href}?public-security-test`));
  } finally {
    if (previousDbFile === undefined) delete process.env.LEADS_DB_FILE;
    else process.env.LEADS_DB_FILE = previousDbFile;
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  servers.push({ name: 'server.js', baseUrl, databaseFile: fixture.databaseFile, close: () => new Promise((resolve) => server.close(resolve)) });
}

async function startTypeScriptServer() {
  const fixture = await createSandbox();
  const sourcePath = path.join(fixture.sandbox, 'server.ts');
  const previousDbFile = process.env.LEADS_DB_FILE;
  const originalUserInfo = os.userInfo;
  process.env.LEADS_DB_FILE = fixture.databaseFile;
  // Node's Windows getUserInfo call fails in some locked-down runners;
  // tsx only needs a temporary-directory username during loader setup.
  os.userInfo = () => ({ username: 'security-test', uid: -1, gid: -1, shell: null, homedir: os.homedir() });
  syncBuiltinESMExports();
  let app;
  try {
    const { tsImport } = await import('tsx/esm/api');
    ({ app } = await tsImport(pathToFileURL(sourcePath).href, import.meta.url));
  } finally {
    if (previousDbFile === undefined) delete process.env.LEADS_DB_FILE;
    else process.env.LEADS_DB_FILE = previousDbFile;
    os.userInfo = originalUserInfo;
    syncBuiltinESMExports();
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  servers.push({
    name: 'server.ts',
    baseUrl,
    databaseFile: fixture.databaseFile,
    close: () => new Promise((resolve) => server.close(resolve)),
  });
}

before(async () => {
  await startJavaScriptServer();
  await startTypeScriptServer();
});

after(async () => {
  for (const server of servers) await server.close();
  for (const tempDir of tempDirs) await rm(tempDir, { recursive: true, force: true });
});

async function request(server, method, route, payload) {
  const target = new URL(server.baseUrl);
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      method,
      path: route,
      agent: false,
      headers: body === undefined ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result;
}

test('both servers initialize a missing store and preserve an existing synthetic store', async (t) => {
  for (const kind of ['server.js', 'server.ts']) {
    await t.test(kind, async () => {
      const fixture = await createSandbox({ includeDatabase: false });
      const previousDbFile = process.env.LEADS_DB_FILE;
      const originalUserInfo = os.userInfo;
      process.env.LEADS_DB_FILE = fixture.databaseFile;
      if (kind === 'server.ts') {
        os.userInfo = () => ({ username: 'security-test', uid: -1, gid: -1, shell: null, homedir: os.homedir() });
        syncBuiltinESMExports();
      }
      try {
        if (kind === 'server.js') {
          await import(`${pathToFileURL(path.join(fixture.sandbox, kind)).href}?missing-store-test`);
        } else {
          const { tsImport } = await import('tsx/esm/api');
          await tsImport(pathToFileURL(path.join(fixture.sandbox, kind)).href, import.meta.url);
        }
      } finally {
        if (previousDbFile === undefined) delete process.env.LEADS_DB_FILE;
        else process.env.LEADS_DB_FILE = previousDbFile;
        os.userInfo = originalUserInfo;
        syncBuiltinESMExports();
      }

      const initialized = JSON.parse(await readFile(fixture.databaseFile, 'utf8'));
      assert.deepEqual(initialized.inquiries, []);
      assert.equal(typeof initialized.initializedAt, 'string');

      const existingFixture = await createSandbox();
      process.env.LEADS_DB_FILE = existingFixture.databaseFile;
      if (kind === 'server.ts') {
        os.userInfo = () => ({ username: 'security-test', uid: -1, gid: -1, shell: null, homedir: os.homedir() });
        syncBuiltinESMExports();
      }
      try {
        if (kind === 'server.js') {
          await import(`${pathToFileURL(path.join(existingFixture.sandbox, kind)).href}?existing-store-test`);
        } else {
          const { tsImport } = await import('tsx/esm/api');
          await tsImport(pathToFileURL(path.join(existingFixture.sandbox, kind)).href, import.meta.url);
        }
      } finally {
        if (previousDbFile === undefined) delete process.env.LEADS_DB_FILE;
        else process.env.LEADS_DB_FILE = previousDbFile;
        os.userInfo = originalUserInfo;
        syncBuiltinESMExports();
      }
      const existing = JSON.parse(await readFile(existingFixture.databaseFile, 'utf8'));
      assert.equal(existing.inquiries[0].marker, existingFixture.marker);
    });
  }
});

test('public build contains only public site and demo files', async () => {
  const files = await listFiles(publicDir);
  const forbidden = /(^|\/)(data|src|node_modules|\.git|\.aistudio|\.github)(\/|$)|(^|\/)(server\.(js|ts)|package(-lock)?\.json|\.env(?:\..*)?|firebase-applet-config\.json|firebase-blueprint\.json|security_spec\.md|walkthrough\.md|firestore\.rules|firebase\.json)$/i;
  assert.deepEqual(files.filter((file) => forbidden.test(file)), []);
  assert.equal(files.filter((file) => file.startsWith('conceptual projects/')).length, 50);
  for (const required of [
    'index.html', 'projects.html', 'services.html', 'styles.css', 'main.js',
    'manifest.webmanifest', 'ravana.webp', 'assets/js/gallery.js', 'assets/js/contact-form.js',
    'assets/js/archive-nav.js', 'assets/js/services-deck.js',
    'assets/img/image_01_opt.webp', 'work1.jpg',
    'assets/img/ravana_tech_logo_1792581937150.jpg',
  ]) assert.ok(files.includes(required), `missing public file: ${required}`);
});

test('both inquiry APIs acknowledge only persisted synthetic records and preserve unreadable stores', async (t) => {
  const inquiry = {
    name: 'Test Customer', email: 'test@example.invalid', service: 'Website',
    message: 'SYNTHETIC_INQUIRY_REGRESSION_ONLY',
  };
  for (const server of servers) {
    await t.test(server.name, async (serverTest) => {
      await serverTest.test('successful receipt corresponds to a saved record', async () => {
        const response = await request(server, 'POST', '/api/inquiry', inquiry);
        assert.equal(response.status, 200);
        const receipt = JSON.parse(response.text);
        assert.equal(receipt.success, true);
        assert.equal(typeof receipt.leadId, 'string');
        const store = JSON.parse(await readFile(server.databaseFile, 'utf8'));
        const saved = store.inquiries.find((record) => record.id === receipt.leadId);
        assert.equal(saved.message, inquiry.message);
        assert.equal(saved.email, inquiry.email);
      });

      await serverTest.test('a failed disk write returns 500 without a receipt', async () => {
        const before = await readFile(server.databaseFile, 'utf8');
        const originalWrite = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => {
          if (path.resolve(String(file)) === server.databaseFile) {
            throw Object.assign(new Error('Synthetic disk full fixture'), { code: 'ENOSPC' });
          }
          return originalWrite(file, ...args);
        };
        let response;
        try {
          response = await request(server, 'POST', '/api/inquiry', inquiry);
        } finally {
          fs.writeFileSync = originalWrite;
        }
        assert.equal(response.status, 500);
        const result = JSON.parse(response.text);
        assert.equal(result.success, false);
        assert.equal(result.leadId, undefined);
        assert.equal(await readFile(server.databaseFile, 'utf8'), before);
      });

      await serverTest.test('an unreadable store is not replaced with an empty database', async () => {
        const before = await readFile(server.databaseFile, 'utf8');
        const corruptFixture = 'SYNTHETIC_INVALID_JSON_ONLY';
        await writeFile(server.databaseFile, corruptFixture);
        try {
          const response = await request(server, 'POST', '/api/inquiry', inquiry);
          assert.equal(response.status, 500);
          assert.equal(JSON.parse(response.text).success, false);
          assert.equal(await readFile(server.databaseFile, 'utf8'), corruptFixture);
        } finally {
          await writeFile(server.databaseFile, before);
        }
      });
    });
  }
});

test('GET and HEAD cannot disclose private paths, rules, blueprints, or docs', async (t) => {
  const privateRoutes = [
    '/data/leads-db.json',
    '/assets/data/leads-db.json',
    '/assets/js/data/leads-db.json',
    '/server.js', '/assets/server.js', '/assets/js/server.js',
    '/server.ts', '/package.json', '/.env', '/.git/HEAD',
    '/firebase-init.js', '/firebase-applet-config.json', '/firebase-blueprint.json',
    '/firestore.rules', '/firebase.json', '/DRAFT_firestore.rules',
    '/security_spec.md', '/walkthrough.md', '/README.md',
    '/vite.config.ts', '/src/types.ts', '/metadata.json',
    '/assets/.git/HEAD', '/assets/js/.git/HEAD',
    '/assets/js/package.json', '/assets/css/server.js', '/assets/img/data/leads-db.json',
    '/assets/js/../../package.json', '/assets%2fjs%2f..%2f..%2fpackage.json',
    '/conceptual%20projects/../server.js',
    '/%252e%252egit/HEAD',
  ];

  for (const server of servers) {
    await t.test(server.name, async (serverTest) => {
      for (const route of privateRoutes) {
        await serverTest.test(`GET ${route}`, async () => {
          const response = await request(server, 'GET', route);
          assert.ok([403, 404].includes(response.status), `unexpected status ${response.status}`);
          assert.doesNotMatch(response.headers['content-type'] || '', /text\/html/i);
          assert.doesNotMatch(response.text, /SYNTHETIC_PRIVATE_FIXTURE_ONLY|<!doctype html/i);
        });
        await serverTest.test(`HEAD ${route}`, async () => {
          const response = await request(server, 'HEAD', route);
          assert.ok([403, 404].includes(response.status), `unexpected status ${response.status}`);
          assert.doesNotMatch(response.headers['content-type'] || '', /text\/html/i);
          assert.equal(response.text, '');
        });
      }
    });
  }
});

test('main pages, required assets, and representative demos load', async (t) => {
  const expected = [
    ['/', /RAVANA TECH/i],
    ['/home', /RAVANA TECH/i],
    ['/about', /RAVANA TECH/i],
    ['/systems', /RAVANA TECH/i],
    ['/services', /RAVANA TECH/i],
    ['/projects', /RAVANA TECH/i],
    ['/contact', /RAVANA TECH/i],
    ['/ai-lab', /RAVANA TECH/i],
    ['/automation', /RAVANA TECH/i],
    ['/lab', /RAVANA TECH/i],
    ['/experience', /RAVANA TECH/i],
    ['/projects.html', /Conceptual Blueprints Archive/i],
    ['/archive', /Conceptual Blueprints Archive/i],
    ['/gallery', /Conceptual Blueprints Archive/i],
    ['/services.html', /Web Engineering Services|Web Solutions/i],
    ['/all-services', /Web Engineering Services|Web Solutions/i],
    ['/styles.css', /:root/],
    ['/main.js', /initDeckRoute/],
    ['/assets/js/gallery.js', /renderGallery/],
    ['/assets/js/contact-form.js', /bindContactForm/],
    ['/assets/js/archive-nav.js', /archive/i],
    ['/assets/js/services-deck.js', /services/i],
    ['/assets/img/image_01_opt.webp', null],
    ['/assets/img/ravana_tech_logo_1792581937150.jpg', null],
    ['/manifest.webmanifest', /icons/],
    ['/ravana.webp', null],
    ['/work1.jpg', null],
    ['/conceptual%20projects/Conceptual%20Site%20for%20Bakery.html', /React Artifact/],
    ['/conceptual%20projects/Conceptual_Site_for_Yoga_Studio.html', /Yoga Studio/i],
    ['/conceptual-projects/Conceptual_Site_for_Yoga_Studio.html', /Yoga Studio/i],
  ];

  for (const server of servers) {
    await t.test(server.name, async (serverTest) => {
      for (const [route, content] of expected) {
        await serverTest.test(`GET ${route}`, async () => {
          const response = await request(server, 'GET', route);
          assert.equal(response.status, 200, `${route} returned ${response.status}`);
          if (content) assert.match(response.text, content, `${route} did not contain expected content`);
          else assert.ok(Buffer.byteLength(response.text) > 0, `${route} was empty`);
        });
      }
    });
  }
});

test('security headers, strict CSP, prototype-pollution guards, and API input checks hold across both servers', async (t) => {
  async function rawRequest(server, method, route, headers, rawBody) {
    const target = new URL(server.baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        method,
        path: route,
        agent: false,
        headers: rawBody === undefined ? headers : {
          ...headers,
          'Content-Length': Buffer.byteLength(rawBody),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.once('error', reject);
      req.end(rawBody);
    });
  }

  for (const server of servers) {
    await t.test(server.name, async (serverTest) => {
      await serverTest.test('main pages enforce strict zero-unsafe-inline script-src CSP and enterprise headers', async () => {
        const home = await request(server, 'GET', '/');
        assert.equal(home.status, 200);
        assert.equal(home.headers['x-content-type-options'], 'nosniff');
        assert.equal(home.headers['x-permitted-cross-domain-policies'], 'none');
        assert.equal(home.headers['x-dns-prefetch-control'], 'off');
        assert.equal(home.headers['origin-agent-cluster'], '?1');
        assert.equal(home.headers['x-powered-by'], undefined);
        const csp = String(home.headers['content-security-policy'] || '');
        const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/i);
        assert.ok(scriptSrcMatch, 'CSP must define script-src');
        assert.doesNotMatch(scriptSrcMatch[1], /'unsafe-inline'|'unsafe-eval'/i);
        assert.match(csp, /object-src\s+'none'/i);
      });

      await serverTest.test('API responses prevent caching and /api/health returns security metadata', async () => {
        const health = await request(server, 'GET', '/api/health');
        assert.equal(health.status, 200);
        assert.match(String(health.headers['cache-control'] || ''), /no-store/i);
        const body = JSON.parse(health.text);
        assert.equal(body.security.strictScriptCsp, true);
      });

      await serverTest.test('/api/document-sim blocks prototype property lookup and invalid sampleId', async () => {
        for (const badId of ['constructor', '__proto__', 'toString', 'valueOf', 'unknown_doc']) {
          const res = await request(server, 'POST', '/api/document-sim', { sampleId: badId });
          assert.equal(res.status, 400, `expected 400 for sampleId=${badId}, got ${res.status}`);
        }
        const ok = await request(server, 'POST', '/api/document-sim', { sampleId: 'hvac' });
        assert.equal(ok.status, 200);
        assert.equal(JSON.parse(ok.text).document.docId, 'TS-MEP-HVAC-0881');
      });

      await serverTest.test('POST APIs reject prototype pollution keys, malformed JSON, wrong Content-Type, and untrusted Origin', async () => {
        const protoRes = await rawRequest(
          server,
          'POST',
          '/api/inquiry',
          { 'Content-Type': 'application/json' },
          '{"__proto__":{"polluted":true},"name":"A","email":"a@b.com","message":"Hi"}'
        );
        assert.equal(protoRes.status, 400);

        const ctorRes = await request(server, 'POST', '/api/inquiry', {
          constructor: { prototype: { polluted: true } },
          name: 'A',
          email: 'a@b.com',
          message: 'Hi',
        });
        assert.equal(ctorRes.status, 400);

        const badJson = await rawRequest(
          server,
          'POST',
          '/api/inquiry',
          { 'Content-Type': 'application/json' },
          '{invalid-json'
        );
        assert.equal(badJson.status, 400);
        assert.equal(JSON.parse(badJson.text).success, false);

        const badType = await rawRequest(
          server,
          'POST',
          '/api/inquiry',
          { 'Content-Type': 'text/plain' },
          'hello'
        );
        assert.equal(badType.status, 415);

        const evilOrigin = await rawRequest(
          server,
          'POST',
          '/api/inquiry',
          { 'Content-Type': 'application/json', Origin: 'https://evil-attacker.invalid' },
          JSON.stringify({ name: 'A', email: 'a@b.com', message: 'Hi' })
        );
        assert.equal(evilOrigin.status, 403);
      });
    });
  }
});

test('unknown paths return HTTP 404 instead of an HTML fallback', async (t) => {
  for (const server of servers) {
    await t.test(server.name, async () => {
      const response = await request(server, 'GET', '/does-not-exist');
      assert.equal(response.status, 404);
      assert.doesNotMatch(response.headers['content-type'] || '', /text\/html/i);
      assert.notEqual(response.text, await readFile(path.join(publicDir, 'index.html'), 'utf8'));
    });
  }
});

test('Firebase Hosting is configured to publish only the allowlisted build without a catch-all rewrite', async () => {
  const firebase = JSON.parse(await readFile(path.join(root, 'firebase.json'), 'utf8'));
  assert.equal(firebase.hosting.public, 'public-build');
  assert.ok(firebase.hosting.rewrites.every((rewrite) => rewrite.source !== '**' && rewrite.source !== '/**'));
  const globalHeaders = firebase.hosting.headers.find((rule) => rule.source === '**');
  assert.ok(globalHeaders);
  const cspHeader = globalHeaders.headers.find((h) => h.key === 'Content-Security-Policy');
  assert.ok(cspHeader);
  const scriptSrcMatch = cspHeader.value.match(/script-src\s+([^;]+)/i);
  assert.ok(scriptSrcMatch);
  assert.doesNotMatch(scriptSrcMatch[1], /'unsafe-inline'|'unsafe-eval'/i);
});
