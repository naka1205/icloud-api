import type { FastifyReply } from 'fastify';
import { asBackendError } from './errors.js';

/** Unified response envelope: {success:true, data} / {success:false, code, message}. */
export function ok(reply: FastifyReply, data: unknown, status = 200): void {
  void reply.code(status).send({ success: true, data });
}

export function fail(reply: FastifyReply, status: number, code: string, message: string): void {
  void reply.code(status).send({ success: false, code, message });
}

/** Map a thrown error to the unified failure envelope (backendFail). */
export function backendFail(reply: FastifyReply, err: unknown): void {
  const be = asBackendError(err);
  fail(reply, be.status, be.code, be.message);
}
