import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTemplate, TemplateParsingError } from './parser.js';
import { tokenizeTemplate } from './tokenizer.js';

describe('template parser', () => {
  it('builds nested interpolation, loop, and conditional nodes', () => {
    const source = [
      '<h1>{{ title }}</h1>',
      '{% for item in items %}',
      '<p>{{ item.description }}</p>',
      '{% if item.featured %}Featured{% endif %}',
      '{% endfor %}',
    ].join('\n');

    const nodes = parseTemplate(tokenizeTemplate(source));
    const loop = nodes.find((node) => node.kind === 'for');

    assert.ok(loop);
    assert.equal(loop.itemName, 'item');
    assert.equal(loop.iterableExpression, 'items');
    assert.equal(loop.body.some((node) => node.kind === 'interpolation' && node.expression === 'item.description'), true);

    const conditional = loop.body.find((node) => node.kind === 'if');
    assert.ok(conditional);
    assert.equal(conditional.branches[0]?.condition, 'item.featured');
    assert.deepEqual(conditional.branches[0]?.body.map((node) => node.kind), ['text']);
  });

  it('groups else-if and else bodies into one conditional', () => {
    const source = "{% if count > 0 %}many{% else if count === 0 %}none{% else %}unknown{% endif %}";
    const nodes = parseTemplate(tokenizeTemplate(source));
    const conditional = nodes[0];

    assert.ok(conditional);
    assert.equal(conditional.kind, 'if');
    if (conditional.kind !== 'if') return;

    assert.deepEqual(
      conditional.branches.map((branch) => ({ condition: branch.condition, text: branch.body[0]?.kind === 'text' ? branch.body[0].value : undefined })),
      [
        { condition: 'count > 0', text: 'many' },
        { condition: 'count === 0', text: 'none' },
      ],
    );
    assert.equal(conditional.elseBody?.[0]?.kind === 'text' ? conditional.elseBody[0].value : undefined, 'unknown');
  });

  it('retains interpolation expressions for the expression evaluator', () => {
    const nodes = parseTemplate(tokenizeTemplate("<div class=\"{{ isActive ? 'active' : 'inactive' }}\"></div>"));
    const interpolation = nodes.find((node) => node.kind === 'interpolation');

    assert.ok(interpolation);
    assert.equal(interpolation.expression, "isActive ? 'active' : 'inactive'");
  });

  it('rejects malformed and unknown statements', () => {
    const cases = [
      ['{{ }}', /Interpolation cannot be empty/],
      ['{% if %}', /"if" requires a condition/],
      ['{% else if %}', /"else if" requires a condition/],
      ['{% for item items %}', /Expected "for <item> in <iterable>"/],
      ['{% for loop in items %}{% endfor %}', /Loop variable "loop" is reserved/],
      ['{% include header %}', /Unknown statement "include header"/],
    ] as const;

    for (const [source, expectedMessage] of cases) {
      assert.throws(() => parseTemplate(tokenizeTemplate(source)), expectedMessage);
    }
  });

  it('rejects unexpected closing statements', () => {
    for (const statement of ['else', 'else if ready', 'endif', 'endfor']) {
      assert.throws(() => parseTemplate(tokenizeTemplate(`{% ${statement} %}`)), (error: unknown) => {
        assert.ok(error instanceof TemplateParsingError);
        assert.match(error.message, /Unexpected/);
        assert.deepEqual(error.location, { offset: 0, line: 1, column: 1 });
        return true;
      });
    }
  });

  it('reports unclosed blocks at their opening location', () => {
    const cases = [
      ['before\n  {% if ready %}yes', /Unclosed "if" statement; expected "endif" at line 2, column 3/],
      ['before\n  {% for item in items %}{{ item }}', /Unclosed "for" statement; expected "endfor" at line 2, column 3/],
    ] as const;

    for (const [source, expectedMessage] of cases) {
      assert.throws(() => parseTemplate(tokenizeTemplate(source)), expectedMessage);
    }
  });

  it('rejects a mismatched closing statement', () => {
    assert.throws(() => parseTemplate(tokenizeTemplate('{% for item in items %}{% endif %}')), /Unexpected "endif" statement/);
  });
});
