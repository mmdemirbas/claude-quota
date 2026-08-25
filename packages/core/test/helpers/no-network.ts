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
 * Pointing `CLAUDE_CONFIG_DIR` or HOME at a temp directory is not by itself a
 * sandbox. It is closer than it was — the keychain lookup no longer falls back
 * to the default service name — but a test that plants a `.credentials.json`,
 * or runs on a machine where the hashed entry happens to exist, still holds a
 * usable token. The only reliable statement is the one this file makes.
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
