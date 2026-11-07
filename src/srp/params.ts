import { createHash } from 'node:crypto';

/**
 * SRP-6a, 2048-bit MODP group — direct port of internal/srp/params.go.
 *
 * N is the RFC 3526 2048-bit prime (g=2, SHA-256). All arithmetic is BigInt.
 * The iCloud customisation: NoUserNameInX=true, i.e.
 *   x = SHA256(salt | SHA256(":" | passKey))
 * where passKey = PBKDF2-SHA256(SHA256(password), salt, iteration, 32).
 * M1 is the iCloud variant (see calculateM1 — note Go's swapped variable
 * names digestn/digestg are reproduced exactly; XOR is commutative).
 */

const N_HEX_2048 = [
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CB',
  'B4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0',
  'CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740A',
  'DBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481',
  'F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDB',
  'F52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C382',
  '71AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F',
  '9E4AFF73',
].join('');

export const SRP_N_2048 = BigInt('0x' + N_HEX_2048);
export const SRP_G_2048 = 2n;
export const SRP_N_BYTES = 256;

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function padToN(value: bigint, byteLen = SRP_N_BYTES): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length > byteLen) throw new Error('value too large for N');
  if (bytes.length === byteLen) return bytes;
  return Buffer.concat([Buffer.alloc(byteLen - bytes.length), bytes]);
}

export function bytesToBigInt(bytes: Buffer): bigint {
  if (bytes.length === 0) return 0n;
  return BigInt('0x' + bytes.toString('hex'));
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export function calculateA(a: bigint): Buffer {
  return padToN(modPow(SRP_G_2048, a, SRP_N_2048));
}

export function calculateU(aBytes: Buffer, bBytes: Buffer): bigint {
  const h = sha256(Buffer.concat([padToN(bytesToBigInt(aBytes)), padToN(bytesToBigInt(bBytes))]));
  return bytesToBigInt(h);
}

/** S = (B - k * g^x) ^ (a + u*x) mod N. Throws on invalid server B. */
export function calculateS(
  k: bigint,
  x: bigint,
  a: bigint,
  bBytes: Buffer,
  u: bigint,
): Buffer {
  const B = bytesToBigInt(bBytes);
  if (B <= 0n || SRP_N_2048 <= B) {
    throw new Error("invalid server-supplied 'B', must be 1..N-1");
  }
  const gx = modPow(SRP_G_2048, x, SRP_N_2048);
  const base = (((B - k * gx) % SRP_N_2048) + SRP_N_2048) % SRP_N_2048;
  const exp = a + u * x;
  return padToN(modPow(base, exp, SRP_N_2048));
}

export function calculateK(sBytes: Buffer): Buffer {
  return sha256(sBytes);
}

/**
 * x = SHA256(salt | SHA256(":" | passKey)) — NoUserNameInX=true, the
 * username is NOT mixed in (Go params.go calculateX with the flag set in
 * hme/auth.go Login).
 */
export function calculateX(salt: Buffer, passKey: Buffer): bigint {
  const inner = sha256(Buffer.concat([Buffer.from(':'), passKey]));
  return bytesToBigInt(sha256(Buffer.concat([salt, inner])));
}

/** M1 = H(H(padG) xor H(N) | H(username) | salt | A | B | K). */
export function calculateM1(
  username: Buffer,
  salt: Buffer,
  aBytes: Buffer,
  bBytes: Buffer,
  kBytes: Buffer,
): Buffer {
  const digestN = sha256(padToN(SRP_G_2048));
  const digestG = sha256(Buffer.from(SRP_N_2048.toString(16), 'hex'));
  const hxor = Buffer.alloc(digestN.length);
  for (let i = 0; i < digestN.length; i++) hxor[i] = digestN[i] ^ digestG[i];
  return sha256(
    Buffer.concat([hxor, sha256(username), salt, aBytes, bBytes, kBytes]),
  );
}

export function calculateM2(aBytes: Buffer, m1: Buffer, kBytes: Buffer): Buffer {
  return sha256(Buffer.concat([aBytes, m1, kBytes]));
}

/** k = H(N || padG). */
export function getMultiplier(): bigint {
  const n = Buffer.from(SRP_N_2048.toString(16), 'hex');
  const g = padToN(SRP_G_2048, n.length);
  return bytesToBigInt(sha256(Buffer.concat([n, g])));
}
