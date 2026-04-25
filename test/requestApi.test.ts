import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { requestApi } from '../src/usage.js';

/**
 * Fake https.request that returns a request emitter the test can drive.
 * The req emitter gates 'response' / 'error' / 'timeout' events; `end()`
 * is a no-op so the deadline timer is the only thing that resolves the
 * outcome (mirroring the slow-loris case: server never replies, never
 * errors, never disconnects).
 */
function makeFakeRequest(opts: { onRequest?: (emitter: EventEmitter) => void } = {}): typeof import('node:http').request {
  return ((_options: RequestOptions, _cb?: (res: IncomingMessage) => void): ClientRequest => {
    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = () => { /* never sends */ };
    (req as unknown as { destroy: () => void }).destroy = () => { req.emit('close'); };
    opts.onRequest?.(req as unknown as EventEmitter);
    return req;
  }) as typeof import('node:http').request;
}

describe('requestApi absolute deadline', () => {
  // R1 regression: req.timeout is per-activity. A server that holds the
  // socket open without sending bytes (slow-loris) won't trip it. The
  // absolute setTimeout(req.destroy, timeoutMs) inside requestApi is what
  // bounds the overall wait. This test pins that behaviour so a future
  // refactor of requestApi can't silently drop it.
  test('resolves with kind:timeout when the server never responds', async () => {
    const start = Date.now();
    const outcome = await requestApi('/test', 'tok', {
      timeoutMs: 50,
      httpsRequest: makeFakeRequest(),
    });
    const elapsed = Date.now() - start;

    assert.equal(outcome.kind, 'timeout');
    // Should fire near our 50 ms deadline, well under the production
    // API_TIMEOUT_MS of 15 s. Allow generous slack for slow CI.
    assert.ok(elapsed < 1000, `expected <1 s, got ${elapsed} ms`);
  });

  test('does not hang when only a single byte is delivered then silence', async () => {
    // Slow-loris simulation: server emits one byte and then never sends
    // more, never closes. The per-activity req.timeout would reset on
    // each byte; only the absolute deadline saves us.
    const httpsRequest = ((_options: RequestOptions, cb?: (res: IncomingMessage) => void): ClientRequest => {
      const req = new EventEmitter() as unknown as ClientRequest;
      (req as unknown as { end: () => void }).end = () => {
        // Build a Readable that emits one byte then stalls forever.
        const res = Object.assign(new Readable({ read() { /* noop */ } }), {
          statusCode: 200,
          headers: {},
        }) as unknown as IncomingMessage;
        setImmediate(() => {
          cb?.(res);
          (res as unknown as Readable).push(Buffer.from('{'));  // one byte
          // Intentionally never push() more, never push(null).
        });
      };
      (req as unknown as { destroy: () => void }).destroy = () => {
        // When the deadline fires, requestApi destroys the req. Surface
        // as an end on the response stream so collectBody resolves.
        (req as unknown as { _r?: IncomingMessage })._r;
      };
      return req;
    }) as typeof import('node:http').request;

    const start = Date.now();
    const outcome = await requestApi('/test', 'tok', { timeoutMs: 50, httpsRequest });
    const elapsed = Date.now() - start;

    assert.equal(outcome.kind, 'timeout', `expected timeout under slow-loris, got: ${JSON.stringify(outcome)}`);
    assert.ok(elapsed < 1000, `expected <1 s, got ${elapsed} ms`);
  });

  test('200 with full body resolves with kind:ok before the deadline', async () => {
    const httpsRequest = ((_options: RequestOptions, cb?: (res: IncomingMessage) => void): ClientRequest => {
      const req = new EventEmitter() as unknown as ClientRequest;
      (req as unknown as { end: () => void }).end = () => {
        const res = Object.assign(new Readable({ read() { /* noop */ } }), {
          statusCode: 200,
          headers: {},
        }) as unknown as IncomingMessage;
        setImmediate(() => {
          cb?.(res);
          (res as unknown as Readable).push(Buffer.from('{"hello":1}'));
          (res as unknown as Readable).push(null);
        });
      };
      (req as unknown as { destroy: () => void }).destroy = () => { /* noop */ };
      return req;
    }) as typeof import('node:http').request;

    const outcome = await requestApi('/test', 'tok', { timeoutMs: 5000, httpsRequest });
    assert.equal(outcome.kind, 'ok');
    if (outcome.kind === 'ok') {
      assert.equal(outcome.body, '{"hello":1}');
    }
  });
});
