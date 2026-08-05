import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTemplate } from './parser.js';
import { renderTemplate, TemplateRenderingError } from './renderer.js';
import { tokenizeTemplate } from './tokenizer.js';
import { stripHtmlWhitespace } from './whitespace.js';

describe('template renderer', () => {
  it('escapes interpolated text and attribute values', () => {
    const html = render('{{ value }}', { value: '<script title="x">alert(\'x\') & more</script>' });

    assert.equal(html, '&lt;script title=&quot;x&quot;&gt;alert(&#39;x&#39;) &amp; more&lt;/script&gt;');
  });

  it('renders nested loops, conditions, parent values, and loop metadata', () => {
    const source = [
      '{% for group in groups %}',
      '{% if group.visible && group.items.length > 0 %}',
      '{{ group.name }}:',
      '{% for item in group.items %}[{{ loop.index }}/{{ loop.length }}={{ item }}]{% endfor %}',
      '{% else %}hidden{% endif %}',
      '{% endfor %}',
    ].join('');

    const html = render(source, {
      groups: [
        { name: 'A', visible: true, items: ['one', 'two'] },
        { name: 'B', visible: false, items: ['three'] },
        { name: 'C', visible: true, items: [] },
      ],
    });

    assert.equal(html, 'A:[1/2=one][2/2=two]hiddenhidden');
  });

  it('inserts trusted rendered content through the layout slot', () => {
    const content = render('<main>{{ title }}</main>', { title: '<Portfolio>' });
    const layout = parseTemplate(tokenizeTemplate('<body>{% content %}</body>'));

    assert.equal(renderTemplate(layout, {}, { content }), '<body><main>&lt;Portfolio&gt;</main></body>');
    assert.throws(() => renderTemplate(layout, {}), /can only be rendered by a layout/);
  });

  it('renders nullish values as empty and rejects unsupported values', () => {
    assert.equal(render('{{ value }}', { value: null }), '');
    assert.equal(render('{{ value }}', { value: undefined }), '');
    assert.throws(() => render('{{ value }}', { value: {} }), /Cannot interpolate a value of type "object"/);
  });

  it('reports expression failures at the template location', () => {
    assert.throws(
      () => render('<h1>\n  {{ missing.name }}\n</h1>', {}),
      (error: unknown) => {
        assert.ok(error instanceof TemplateRenderingError);
        assert.deepEqual(error.location, { offset: 7, line: 2, column: 3 });
        assert.match(error.message, /Unknown template value "missing" at template line 2, column 3/);
        return true;
      },
    );
  });

  it('rejects loop expressions that are not arrays', () => {
    assert.throws(() => render('{% for item in items %}{{ item }}{% endfor %}', { items: 'not-an-array' }), /must resolve to an array/);
  });
});

describe('template whitespace stripping', () => {
  it('removes HTML and CSS formatting newlines while preserving inline spaces and whitespace-sensitive blocks', () => {
    const html = [
      '<div>',
      '  <span>Hello</span> <span>world</span>',
      '</div>',
      '<pre>\n  keep   this\n</pre>',
      '<style>\n  .card { color: red; }\n</style>',
    ].join('\n');

    assert.equal(stripHtmlWhitespace(html), '<div><span>Hello</span> <span>world</span></div><pre>\n  keep   this\n</pre><style>.card { color: red; }</style>');
  });
});

function render(source: string, data: object): string {
  return renderTemplate(parseTemplate(tokenizeTemplate(source)), data);
}
