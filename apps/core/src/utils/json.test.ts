import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { safeJsonParse, safeJsonStringify } from './json.js';

describe('JSON utilities', () => {
  describe('safeJsonParse', () => {
    it('parses objects, arrays, and primitive JSON values', () => {
      const cases: readonly [string, unknown][] = [
        ['{"name":"Miro","active":true}', { name: 'Miro', active: true }],
        ['[1,"two",null]', [1, 'two', null]],
        ['"hello"', 'hello'],
        ['42', 42],
        ['true', true],
        ['null', null],
      ];

      for (const [source, expected] of cases) {
        const result = safeJsonParse(source);

        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.value, expected);
      }
    });

    it('returns the parsing error for malformed JSON', () => {
      const result = safeJsonParse('{"unfinished":');

      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error instanceof SyntaxError);
    });
  });

  describe('safeJsonStringify', () => {
    it('serializes objects, arrays, and primitive values', () => {
      const cases: readonly [unknown, string][] = [
        [{ name: 'Miro', active: true }, '{"name":"Miro","active":true}'],
        [[1, 'two', null], '[1,"two",null]'],
        ['hello', '"hello"'],
        [42, '42'],
        [true, 'true'],
        [null, 'null'],
      ];

      for (const [value, expected] of cases) {
        const result = safeJsonStringify(value);

        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.value, expected);
      }
    });

    it('rejects undefined unless nullish output is allowed', () => {
      const rejected = safeJsonStringify(undefined);
      const allowed = safeJsonStringify(undefined, true);

      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.ok(rejected.error instanceof TypeError);

      assert.deepEqual(allowed, { ok: true, value: undefined });
    });

    it('returns serialization errors for BigInt and circular references', () => {
      const circular: { self?: unknown } = {};
      circular.self = circular;

      for (const value of [1n, circular]) {
        const result = safeJsonStringify(value);

        assert.equal(result.ok, false);
        if (!result.ok) assert.ok(result.error instanceof TypeError);
      }
    });

    it('preserves errors thrown by custom JSON serialization', () => {
      const expected = new Error('custom serialization failed');
      const result = safeJsonStringify({
        toJSON() {
          throw expected;
        },
      });

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, expected);
    });
  });
});
