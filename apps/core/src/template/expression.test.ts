import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateExpression, ExpressionEvaluationError } from './expression-evaluator.js';
import { parseExpression } from './expression-parser.js';
import { ExpressionTokenizationError } from './expression-tokenizer.js';

describe('template expressions', () => {
  it('respects arithmetic, comparison, and boolean precedence', () => {
    assert.equal(evaluate('1 + 2 * 3 === 7 && !false', {}), true);
    assert.equal(evaluate('(1 + 2) * 3', {}), 9);
    assert.equal(evaluate('10 % 4 + 1', {}), 3);
  });

  it('resolves own properties and conditional expressions', () => {
    const data = { user: { name: 'Miro', score: 8 }, threshold: 5 };

    assert.equal(evaluate("user.score >= threshold ? user.name + '!' : 'hidden'", data), 'Miro!');
  });

  it('parses strings and supported escapes', () => {
    assert.equal(evaluate("'line\\n' + \"two\\u0021\"", {}), 'line\ntwo!');
  });

  it('short-circuits boolean expressions', () => {
    assert.equal(evaluate('false && missing.value', {}), false);
    assert.equal(evaluate("'fallback' || missing.value", {}), 'fallback');
  });

  it('rejects arbitrary JavaScript syntax', () => {
    for (const source of ['helper()', 'items[0]', 'value = 1', 'new Thing']) {
      assert.throws(() => parseExpression(source), SyntaxError);
    }

    assert.throws(() => parseExpression('count == 1'), (error: unknown) => {
      assert.ok(error instanceof ExpressionTokenizationError);
      assert.match(error.message, /Only strict equality operators/);
      return true;
    });
  });

  it('blocks prototype-sensitive and inherited properties', () => {
    assert.throws(() => evaluate('value.constructor', { value: {} }), ExpressionEvaluationError);

    const inherited = Object.create({ secret: 'nope' }) as object;
    assert.throws(() => evaluate('value.secret', { value: inherited }), /Unknown property "secret"/);
  });

  it('reports missing values and invalid operand types', () => {
    assert.throws(() => evaluate('missing', {}), /Unknown template value "missing"/);
    assert.throws(() => evaluate("1 + '2'", {}), /requires two numbers or two strings/);
    assert.throws(() => evaluate('name > 2', { name: 'Miro' }), /same type/);
  });
});

function evaluate(source: string, values: object): unknown {
  return evaluateExpression(parseExpression(source), { values });
}
