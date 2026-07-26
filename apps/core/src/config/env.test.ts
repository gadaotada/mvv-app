import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEnvironment, EnvironmentError } from './env.js';

describe('Environment', () => {
  it('reads and validates supported values', () => {
    const env = createEnvironment({
      HOST: ' 127.0.0.1 ',
      PORT: '3000',
      ENABLED: 'true',
      MODE: 'production',
    });

    assert.equal(env.required('HOST'), '127.0.0.1');
    assert.equal(env.integer('PORT', { min: 1, max: 65_535 }), 3000);
    assert.equal(env.boolean('ENABLED'), true);
    assert.equal(env.oneOf('MODE', ['development', 'production'] as const), 'production');
    assert.equal(env.string('MISSING', { fallback: 'fallback' }), 'fallback');
  });

  it('rejects missing and malformed values', () => {
    const env = createEnvironment({ EMPTY: ' ', EMPTY_INTEGER: '   ', PORT: '3.14', FLAG: 'yes' });

    assert.throws(() => env.required('MISSING'), EnvironmentError);
    assert.throws(() => env.required('EMPTY'), EnvironmentError);
    assert.throws(() => env.integer('EMPTY_INTEGER'), EnvironmentError);
    assert.throws(() => env.integer('PORT'), EnvironmentError);
    assert.throws(() => env.boolean('FLAG'), EnvironmentError);
  });
});
