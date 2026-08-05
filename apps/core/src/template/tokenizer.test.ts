import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TemplateTokenizationError, tokenizeTemplate } from './tokenizer.js';

describe('template tokenizer', () => {
  it('tokenizes text, interpolations, and statements', () => {
    const source = '<h1>{{ title }}</h1>\n{% if showFooter %}<footer>{{ footerText }}</footer>{% endif %}';

    assert.deepEqual(tokenizeTemplate(source), [
      { kind: 'text', value: '<h1>', location: { offset: 0, line: 1, column: 1 } },
      { kind: 'interpolation', value: 'title', location: { offset: 4, line: 1, column: 5 } },
      { kind: 'text', value: '</h1>\n', location: { offset: 15, line: 1, column: 16 } },
      { kind: 'statement', value: 'if showFooter', location: { offset: 21, line: 2, column: 1 } },
      { kind: 'text', value: '<footer>', location: { offset: 40, line: 2, column: 20 } },
      { kind: 'interpolation', value: 'footerText', location: { offset: 48, line: 2, column: 28 } },
      { kind: 'text', value: '</footer>', location: { offset: 64, line: 2, column: 44 } },
      { kind: 'statement', value: 'endif', location: { offset: 73, line: 2, column: 53 } },
    ]);
  });

  it('preserves plain HTML and CSS exactly', () => {
    const source = '<style>.card { color: red; }</style>\n<main>Static</main>';

    assert.deepEqual(tokenizeTemplate(source), [{ kind: 'text', value: source, location: { offset: 0, line: 1, column: 1 } }]);
  });

  it('treats script elements as raw text', () => {
    const script = [
      '<SCRIPT type="module" data-example="{{ ignoredAttribute }}">',
      '  const interpolation = "{{ ignoredValue }}";',
      '  const statement = "{% if ignoredCondition %}";',
      '</SCRIPT>',
    ].join('\n');
    const source = `${script}<p>{{ title }}</p>`;
    const tokens = tokenizeTemplate(source);

    assert.equal(tokens[0]?.kind, 'text');
    assert.equal(tokens[0]?.value, script);
    assert.deepEqual(tokens.slice(1), [
      { kind: 'text', value: '<p>', location: { offset: script.length, line: 4, column: 10 } },
      { kind: 'interpolation', value: 'title', location: { offset: script.length + 3, line: 4, column: 13 } },
      { kind: 'text', value: '</p>', location: { offset: script.length + 14, line: 4, column: 24 } },
    ]);
  });

  it('returns no tokens for an empty template', () => {
    assert.deepEqual(tokenizeTemplate(''), []);
  });

  it('reports the opening location of an unclosed interpolation', () => {
    assert.throws(
      () => tokenizeTemplate('<h1>Title</h1>\n  {{ title'),
      (error: unknown) => {
        assert.ok(error instanceof TemplateTokenizationError);
        assert.deepEqual(error.location, { offset: 17, line: 2, column: 3 });
        assert.match(error.message, /Unclosed interpolation at line 2, column 3/);
        return true;
      },
    );
  });

  it('reports the opening location of an unclosed statement', () => {
    assert.throws(
      () => tokenizeTemplate('{% for item in items'),
      (error: unknown) => {
        assert.ok(error instanceof TemplateTokenizationError);
        assert.deepEqual(error.location, { offset: 0, line: 1, column: 1 });
        assert.match(error.message, /Unclosed statement at line 1, column 1/);
        return true;
      },
    );
  });

  it('reports the opening location of an unclosed script element', () => {
    assert.throws(
      () => tokenizeTemplate('<main>Before</main>\n  <script>const example = "{{ ignored }}";'),
      (error: unknown) => {
        assert.ok(error instanceof TemplateTokenizationError);
        assert.deepEqual(error.location, { offset: 22, line: 2, column: 3 });
        assert.match(error.message, /Unclosed <script> element at line 2, column 3/);
        return true;
      },
    );
  });
});
