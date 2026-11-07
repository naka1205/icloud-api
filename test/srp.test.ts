import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { SrpClient } from '../src/srp/client.js';
import {
  calculateA,
  calculateK,
  calculateM1,
  calculateM2,
  calculateS,
  calculateU,
  calculateX,
  getMultiplier,
  padToN,
  bytesToBigInt,
  modPow,
  SRP_N_2048,
  SRP_G_2048,
} from '../src/srp/params.js';

/**
 * Independent reimplementation of the Go SRP math, written straight from
 * internal/srp/params.go (constants re-typed from the Go source) — used to
 * cross-check the module under test rather than trusting it to agree with
 * itself.
 */

const N_HEX_GO =
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CB' +
  'B4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0' +
  'CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740A' +
  'DBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481' +
  'F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDB' +
  'F52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C382' +
  '71AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F' +
  '9E4AFF73';

const N_GO = BigInt('0x' + N_HEX_GO);

function sha(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function pad(v: bigint): Buffer {
  let hex = v.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const b = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(256 - b.length), b]);
}

function toBig(b: Buffer): bigint {
  return BigInt('0x' + b.toString('hex'));
}

function pow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let x = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * x) % mod;
    x = (x * x) % mod;
    e >>= 1n;
  }
  return r;
}

test('SRP N constant matches Go params.go exactly', () => {
  assert.equal(SRP_N_2048, N_GO);
  assert.equal(SRP_G_2048, 2n);
});

test('SRP self-consistency: deterministic A/M1/M2 for fixed inputs', () => {
  const a = Buffer.from(
    '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    'hex',
  );
  const salt = Buffer.from('aabbccddeeff00112233445566778899', 'hex');
  const password = 'test-password-123';
  const username = Buffer.from('user@icloud.com', 'utf8');
  const iteration = 1000;

  const passHash = sha(Buffer.from(password, 'utf8'));
  const passKey = pbkdf2Sync(passHash, salt, iteration, 32, 'sha256');

  // Independent computation (Go math, reimplemented here).
  const kGo = toBig(sha(Buffer.concat([pad(N_GO), pad(2n)])));
  const AG = pad(pow(2n, toBig(a), N_GO));
  // Simulate a server B: pick b, B = g^b mod N.
  const b = Buffer.from(
    'ffeeddccbbaa9988776655443322110000112233445566778899aabbccddeeff',
    'hex',
  );
  const BG = pad(pow(2n, toBig(b), N_GO));
  const xGo = toBig(sha(Buffer.concat([salt, sha(Buffer.concat([Buffer.from(':'), passKey]))])));
  const uGo = toBig(sha(Buffer.concat([pad(toBig(AG)), pad(toBig(BG))])));
  const baseGo = (((toBig(BG) - kGo * pow(2n, xGo, N_GO)) % N_GO) + N_GO) % N_GO;
  const SGo = pad(pow(baseGo, toBig(a) + uGo * xGo, N_GO));
  const KGo = sha(SGo);
  const hN = sha(pad(2n));
  const hG = sha(Buffer.from(N_GO.toString(16), 'hex'));
  const xor = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) xor[i] = hN[i] ^ hG[i];
  const M1Go = sha(Buffer.concat([xor, sha(username), salt, AG, BG, KGo]));
  const M2Go = sha(Buffer.concat([AG, M1Go, KGo]));

  // Module under test.
  const client = new SrpClient(a);
  assert.equal(client.getABytes().toString('hex'), AG.toString('hex'));
  assert.equal(getMultiplier(), kGo);
  assert.equal(calculateA(toBig(a)).toString('hex'), AG.toString('hex'));
  assert.equal(calculateX(salt, passKey), xGo);
  assert.equal(calculateU(AG, BG), uGo);
  assert.equal(
    calculateS(kGo, xGo, toBig(a), BG, uGo).toString('hex'),
    SGo.toString('hex'),
  );
  assert.equal(calculateK(SGo).toString('hex'), KGo.toString('hex'));
  assert.equal(calculateM1(username, salt, AG, BG, KGo).toString('hex'), M1Go.toString('hex'));
  assert.equal(calculateM2(AG, M1Go, KGo).toString('hex'), M2Go.toString('hex'));

  client.processChallenge(username, passKey, salt, BG);
  assert.equal(client.getM1Bytes().toString('hex'), M1Go.toString('hex'));
  assert.equal(client.getM2Bytes().toString('hex'), M2Go.toString('hex'));
  assert.equal(client.getSessionKey().toString('hex'), KGo.toString('hex'));
  assert.equal(client.checkM2(M2Go), true);
  assert.equal(client.checkM2(Buffer.alloc(32, 1)), false);
});

test('SRP: random secrets produce distinct A values; invalid B throws', () => {
  const c1 = new SrpClient();
  const c2 = new SrpClient();
  assert.notEqual(c1.getABytes().toString('hex'), c2.getABytes().toString('hex'));

  const client = new SrpClient();
  const salt = randomBytes(16);
  const passKey = randomBytes(32);
  assert.throws(
    () => client.processChallenge(Buffer.from('u'), passKey, salt, Buffer.alloc(256, 0)),
    /invalid server-supplied 'B'/,
  );
  // B >= N also throws.
  assert.throws(
    () =>
      client.processChallenge(
        Buffer.from('u'),
        passKey,
        salt,
        padToN(SRP_N_2048),
      ),
    /invalid server-supplied 'B'/,
  );
});
