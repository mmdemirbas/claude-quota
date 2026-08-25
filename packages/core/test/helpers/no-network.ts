import http from 'node:http';
import https from 'node:https';

/**
 * Fail any test that reaches off this machine.
 *
 * Every test here injects a fake fetcher, so today nothing calls out. That is a
 * convention, and a convention that fails silently is not enforcement: the same
 * assumption held in the board's suite until a test reached the real usage API,
 * spent real quota, and was noticed only because an unrelated assertion failed.
 *
 * `CLAUDE_CONFIG_DIR` is not a sandbox — the keychain lookup falls back to the
 * default service name, so a test on a machine with a real Claude login finds a
 * usable token no matter where the config directory points. Nothing about
 * pointing HOME at a temp directory prevents a live call.
 *
 * Preloaded with `node --import`, so it is in place before any test module runs.
 */

const ALLOWED = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostOf(target: unknown): string | null {
  if (typeof target === 'string') {
    try { return new URL(target).hostname; } catch { return null; }
  }
  if (target instanceof URL) return target.hostname;
  if (target !== null && typeof target === 'object') {
    const o = target as { hostname?: unknown; host?: unknown };
    const raw = o.hostname ?? o.host;
    if (typeof raw === 'string') return raw.split(':')[0] ?? raw;
  }
  return null;
}

function guard<T extends (...args: never[]) => unknown>(original: T): T {
  return function (this: unknown, ...args: never[]) {
    const host = hostOf(args[0]);
    if (host !== null && !ALLOWED.has(host)) {
      throw new Error(
        `Blocked network call to ${host} from a test. ` +
        `Pass a fake fetcher via getUsage({ fetcher }) instead — see test/helpers/no-network.ts.`,
      );
    }
    return original.apply(this, args);
  } as T;
}

https.request = guard(https.request);
https.get = guard(https.get);
http.request = guard(http.request);
http.get = guard(http.get);
