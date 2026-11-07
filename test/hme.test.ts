import test from 'node:test';
import assert from 'node:assert/strict';
import { HmeClient, parseAliasList, requestOrigin } from '../src/hme/client.js';
import {
  buildCookieHeader,
  parseSetCookies,
  mergeSetCookies,
} from '../src/hme/http.js';
import type { UpstreamFetch, UpstreamResponse } from '../src/hme/http.js';

// Ported from internal/hme/client_test.go.
test('validationURLs: global host uses only the global endpoint', () => {
  const client = new HmeClient({ cookies: {}, host: 'icloud.com' });
  assert.deepEqual(client.validationURLs(), [
    'https://setup.icloud.com/setup/ws/1/validate',
  ]);
});

test('validationURLs: .cn host falls back to the global endpoint', () => {
  const client = new HmeClient({ cookies: {}, host: 'icloud.com.cn' });
  assert.deepEqual(client.validationURLs(), [
    'https://setup.icloud.com.cn/setup/ws/1/validate',
    'https://setup.icloud.com/setup/ws/1/validate',
  ]);
});

test('requestOrigin: 4 Go cases', () => {
  assert.equal(
    requestOrigin('https://setup.icloud.com/setup/ws/1/validate'),
    'https://www.icloud.com',
  );
  assert.equal(
    requestOrigin('https://setup.icloud.com.cn/setup/ws/1/validate'),
    'https://www.icloud.com.cn',
  );
  assert.equal(
    requestOrigin('https://p123-maildomainws.icloud.com.cn/v2/hme/list'),
    'https://www.icloud.com.cn',
  );
  assert.equal(
    requestOrigin('https://p123-maildomainws.icloud.com/v2/hme/list'),
    'https://www.icloud.com',
  );
});

test('buildCookieHeader: Go double-quote wrapping rule', () => {
  assert.equal(
    buildCookieHeader({ a: 'plain', b: '"already-quoted"' }),
    'a="plain"; b="already-quoted"',
  );
});

test('parseSetCookies / mergeSetCookies', () => {
  const cookies: Record<string, string> = { keep: '1' };
  mergeSetCookies(cookies, ['a=1; Path=/', 'b="2"; HttpOnly', 'empty=; Path=/', 'noeq']);
  assert.deepEqual(cookies, { keep: '1', a: '1', b: '"2"' });
  assert.deepEqual(parseSetCookies(['x=y; Expires=Thu, 01 Jan 1970 00:00:00 GMT']), {
    x: 'y',
  });
});

test('parseAliasList: hmeEmails preferred, sorting, field fallbacks', () => {
  const body = JSON.stringify({
    result: {
      hmeEmails: [
        { hme: 'B@icloud.com', state: 'active', anonymousId: '2', label: 'Beta' },
        { email: 'a@icloud.com', status: 'inactive', id: '1', label: 'Alpha' },
        { alias: 'c@icloud.com', active: false, anonymousId: '3' },
        { address: 'd@icloud.com', state: 'deleted', anonymousId: '4' },
        { hme: 'no-at-sign', anonymousId: '5' },
        { hme: 'e@icloud.com', state: 'ACTIVE', anonymousId: '6', createTimestamp: 1730000000 },
      ],
    },
  });
  const aliases = parseAliasList(body);
  assert.equal(aliases.length, 5);
  // Active first, then email ascending.
  assert.deepEqual(
    aliases.map((a) => a.email),
    ['b@icloud.com', 'e@icloud.com', 'a@icloud.com', 'c@icloud.com', 'd@icloud.com'],
  );
  assert.equal(aliases[0].anonymousId, '2');
  assert.equal(aliases[0].label, 'Beta');
  assert.equal(aliases[1].anonymousId, '6');
  assert.equal(aliases[1].createdAt, '1730000000');
  assert.equal(aliases[2].active, false);
});

test('parseAliasList: invalid JSON -> []; recursive array fallback', () => {
  assert.deepEqual(parseAliasList('not json'), []);
  assert.deepEqual(parseAliasList('{"result":{}}'), []);
  const body = JSON.stringify({
    data: {
      nested: [
        { hme: 'x@icloud.com', state: 'active', anonymousId: '9' },
        { hme: 'y@icloud.com', state: 'active', anonymousId: '8' },
      ],
    },
  });
  const aliases = parseAliasList(body);
  assert.equal(aliases.length, 2);
  assert.equal(aliases[0].email, 'x@icloud.com');
});

// --- Fake-fetch integration (no wreq-js, no network) -----------------------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFakeFetch(
  handlers: Array<(req: Recorded) => UpstreamResponse | null>,
): { fetchFn: UpstreamFetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchFn: UpstreamFetch = async (url, opts) => {
    const rec: Recorded = {
      url,
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    };
    requests.push(rec);
    for (const h of handlers) {
      const resp = h(rec);
      if (resp) return resp;
    }
    return { status: 404, body: 'not found', setCookies: [], headers: {} };
  };
  return { fetchFn, requests };
}

function jsonResponse(body: unknown, setCookies: string[] = []): UpstreamResponse {
  return {
    status: 200,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    setCookies,
    headers: {},
  };
}

test('validateSession: :443 stripping, dsid, identity fallbacks, Set-Cookie merge', async () => {
  const { fetchFn, requests } = makeFakeFetch([
    (req) =>
      req.url.includes('/setup/ws/1/validate')
        ? jsonResponse(
            {
              webservices: {
                premiummailsettings: {
                  url: 'https://p123-maildomainws.icloud.com:443/',
                },
              },
              dsInfo: {
                dsid: '12345',
                appleId: '',
                primaryEmail: 'user@qq.com',
                fullName: 'Test User',
              },
            },
            ['X-APPLE-WEBAUTH-USER=v=1:s=1:d=12345; Path=/'],
          )
        : null,
  ]);
  const client = new HmeClient({
    cookies: { seed: 'abc' },
    host: 'icloud.com',
    fetchFn,
  });
  await client.validateSession();
  assert.equal(client.getServiceUrl(), 'https://p123-maildomainws.icloud.com');
  const info = client.getAccountInfo();
  assert.equal(info?.dsid, '12345');
  assert.equal(info?.primaryEmail, 'user@qq.com');
  assert.equal(info?.fullName, 'Test User');
  // Set-Cookie merged into the cookie map.
  assert.equal(client.cookies['X-APPLE-WEBAUTH-USER'], 'v=1:s=1:d=12345');
  // buildURL params on the validate call: Build13 for setup host.
  // dsid is not known yet at validate time, so no dsid param is sent.
  const validateReq = requests[0];
  assert.ok(validateReq.url.includes('clientBuildNumber=2624Build13'));
  assert.ok(validateReq.url.includes('clientId='));
  assert.ok(!validateReq.url.includes('dsid='));
  // Cookie header uses Go quoting.
  assert.equal(validateReq.headers['Cookie'], 'seed="abc"');
  await client.close();
});

test('validateSession: missing premiummailsettings url fails', async () => {
  const { fetchFn } = makeFakeFetch([
    (req) =>
      req.url.includes('/validate')
        ? jsonResponse({ webservices: {} })
        : null,
  ]);
  const client = new HmeClient({ cookies: { a: '1' }, host: 'icloud.com', fetchFn });
  await assert.rejects(() => client.validateSession(), /validate 响应缺少 Hide My Email 服务端点/);
  await client.close();
});

test('listAliases + createAlias flow through the fake fetch', async () => {
  const { fetchFn, requests } = makeFakeFetch([
    (req) => {
      if (req.url.includes('/validate')) {
        return jsonResponse({
          webservices: { premiummailsettings: { url: 'https://p1-maildomainws.icloud.com' } },
          dsInfo: { dsid: '7', appleId: 'user@icloud.com', primaryEmail: 'user@icloud.com' },
        });
      }
      if (req.url.includes('/v2/hme/list')) {
        return jsonResponse({
          result: {
            hmeEmails: [
              { hme: 'a@icloud.com', state: 'active', anonymousId: '1' },
              { hme: 'b@icloud.com', state: 'inactive', anonymousId: '2' },
            ],
          },
        });
      }
      if (req.url.includes('/v1/hme/generate')) {
        return jsonResponse({ success: true, result: { hme: 'new@icloud.com' } });
      }
      if (req.url.includes('/v1/hme/reserve')) {
        return jsonResponse({ success: true, result: { hme: { hme: 'new@icloud.com' } } });
      }
      return null;
    },
  ]);
  const client = new HmeClient({ cookies: { a: '1' }, host: 'icloud.com', fetchFn });
  const aliases = await client.listAliases();
  assert.equal(aliases.length, 2);
  assert.equal(aliases[0].email, 'a@icloud.com');
  // maildomainws host uses Build22 params; dsid (learned at validate) is sent.
  const listReq = requests.find((r) => r.url.includes('/v2/hme/list'))!;
  assert.ok(listReq.url.includes('clientBuildNumber=2624Build22'));
  assert.ok(listReq.url.includes('dsid=7'));
  assert.equal(listReq.headers['Content-Type'], 'text/plain');
  assert.equal(listReq.headers['Accept'], '*/*');

  const created = await client.createAlias('my label');
  assert.equal(created.email, 'new@icloud.com');
  assert.equal(created.label, 'my label');
  const reserveReq = requests.find((r) => r.url.includes('/v1/hme/reserve'))!;
  const reserveBody = JSON.parse(reserveReq.body!) as Record<string, unknown>;
  assert.equal(reserveBody['hme'], 'new@icloud.com');
  assert.equal(reserveBody['label'], 'my label');
  await client.close();
});

test('deleteAlias: deactivate-then-delete fallback; empty error message', async () => {
  let deleteCalls = 0;
  const { fetchFn } = makeFakeFetch([
    (req) => {
      if (req.url.includes('/validate')) {
        return jsonResponse({
          webservices: { premiummailsettings: { url: 'https://p1-maildomainws.icloud.com' } },
          dsInfo: {},
        });
      }
      if (req.url.includes('/v1/hme/delete')) {
        deleteCalls++;
        if (deleteCalls === 1) return jsonResponse({ success: false });
        return jsonResponse({ success: false });
      }
      if (req.url.includes('/v1/hme/deactivate')) {
        return jsonResponse({ success: true });
      }
      return null;
    },
  ]);
  const client = new HmeClient({ cookies: { a: '1' }, host: 'icloud.com', fetchFn });
  // Second delete returns success=false with no error object: Go's error
  // message is the empty string.
  await assert.rejects(() => client.deleteAlias('anon-1'), (err: Error) => {
    assert.equal(err.message, '');
    return true;
  });
  assert.equal(deleteCalls, 2);
  await client.close();
});

test('request: 401 is never retried', async () => {
  let calls = 0;
  const { fetchFn } = makeFakeFetch([
    () => {
      calls++;
      return { status: 401, body: 'unauthorized', setCookies: [], headers: {} };
    },
  ]);
  const client = new HmeClient({ cookies: {}, host: 'icloud.com', fetchFn });
  await assert.rejects(() => client.request('GET', 'https://setup.icloud.com/x', null, 0, 3), /HTTP 401/);
  assert.equal(calls, 1);
  await client.close();
});

test('request: 500 retries then throws', async () => {
  let calls = 0;
  const { fetchFn } = makeFakeFetch([
    () => {
      calls++;
      return { status: 500, body: 'boom', setCookies: [], headers: {} };
    },
  ]);
  const client = new HmeClient({ cookies: {}, host: 'icloud.com', fetchFn });
  await assert.rejects(() => client.request('GET', 'https://setup.icloud.com/x', null, 0, 2), /HTTP 500/);
  assert.equal(calls, 2);
  await client.close();
});
