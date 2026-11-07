import { randomBytes } from 'node:crypto';
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
} from './params.js';

/**
 * SRP client — port of internal/srp/client.go (NewSRPClient,
 * ProcessClientChanllenge). Only the 2048-bit group is used (Login).
 */
export class SrpClient {
  readonly multiplier: bigint;
  readonly secretA: bigint;
  readonly aBytes: Buffer;
  private x: bigint | null = null;
  private m1: Buffer | null = null;
  private m2: Buffer | null = null;
  private k: Buffer | null = null;

  constructor(a?: Buffer) {
    const secret = a && a.length > 0 ? a : randomBytes(32);
    this.multiplier = getMultiplier();
    this.secretA = bytesToBigInt(secret);
    this.aBytes = calculateA(this.secretA);
  }

  getABytes(): Buffer {
    return this.aBytes;
  }

  /**
   * Process the server challenge. username is the iCloud account name,
   * passKey is PBKDF2-SHA256(SHA256(password), salt, iteration, 32).
   */
  processChallenge(
    username: Buffer,
    passKey: Buffer,
    salt: Buffer,
    bBytes: Buffer,
  ): void {
    this.x = calculateX(salt, passKey);
    const bigB = bytesToBigInt(bBytes);
    const u = calculateU(this.aBytes, bBytes);
    const s = calculateS(this.multiplier, this.x, this.secretA, bBytes, u);
    this.k = calculateK(s);
    const aPadded = padToN(bytesToBigInt(this.aBytes));
    this.m1 = calculateM1(username, salt, aPadded, bBytes, this.k);
    this.m2 = calculateM2(aPadded, this.m1, this.k);
  }

  getM1Bytes(): Buffer {
    if (!this.m1) throw new Error('challenge not processed');
    return this.m1;
  }

  getM2Bytes(): Buffer {
    if (!this.m2) throw new Error('challenge not processed');
    return this.m2;
  }

  getSessionKey(): Buffer {
    if (!this.k) throw new Error('challenge not processed');
    return this.k;
  }

  checkM2(m2: Buffer): boolean {
    if (!this.m2) throw new Error('challenge not processed');
    return this.m2.equals(m2);
  }
}
