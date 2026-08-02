import assert from 'node:assert/strict';
import test from 'node:test';

import { Cache } from './cache.js';

test('stores and retrieves arbitrary values', () => {
  const cache = new Cache<object>();
  const value = { html: '<main>Hello</main>' };

  cache.set('page', value);

  assert.equal(cache.get('page'), value);
  assert.equal(cache.get('missing'), null);
});

test('evicts the oldest entry when capacity is reached', () => {
  const cache = new Cache<string>(2);

  cache.set('first', 'one');
  cache.set('second', 'two');
  cache.set('third', 'three');

  assert.equal(cache.get('first'), null);
  assert.equal(cache.get('second'), 'two');
  assert.equal(cache.get('third'), 'three');
});

test('overwrites an existing entry without evicting another entry', () => {
  const cache = new Cache<string>(2);

  cache.set('first', 'old');
  cache.set('second', 'two');
  cache.set('first', 'new');

  assert.equal(cache.get('first'), 'new');
  assert.equal(cache.get('second'), 'two');
});

test('removes entries', () => {
  const cache = new Cache<string>();

  cache.set('key', 'value');
  cache.remove('key');

  assert.equal(cache.get('key'), null);
});

test('validates capacity', () => {
  assert.throws(() => new Cache(0), /Max Capacity/);
  assert.throws(() => new Cache(1.5), /Max Capacity/);
  assert.throws(() => new Cache(Number.NaN), /Max Capacity/);
});

test('logs and ignores undefined values', (context) => {
  const error = context.mock.method(console, 'error', () => {});
  const cache = new Cache<undefined>();

  cache.set('missing', undefined);

  assert.equal(cache.get('missing'), null);
  assert.equal(error.mock.callCount(), 1);
  assert.deepEqual(error.mock.calls[0]?.arguments, ['Cache.set() called with undefined value for key: missing']);
});
