import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { TemplateEngine, TemplateLoadingError } from './index.js';

describe('template engine', () => {
  it('loads feature templates into layouts and caches parsed templates', async (context) => {
    const fixture = await createFixture(context);
    const engine = new TemplateEngine({ layoutPath: fixture.layouts, stripWhitespace: true });
    const renderPage = await engine.load<{ readonly title: string; readonly projects: readonly string[] }>(pathToFileURL(fixture.page), { layout: 'main.htmv' });

    assert.equal(renderPage({ title: '<Work>', projects: ['One', 'Two'] }), '<!doctype html><title>&lt;Work&gt;</title><main><h1>&lt;Work&gt;</h1><p>1: One</p><p>2: Two</p></main>');

    await writeFile(fixture.page, '<main>changed</main>', 'utf8');
    const renderCachedPage = await engine.load<{ readonly title: string; readonly projects: readonly string[] }>(fixture.page, { layout: 'main.htmv' });
    assert.match(renderCachedPage({ title: 'Cached', projects: [] }), /<h1>Cached<\/h1>/);

    engine.clearCache();
    const renderChangedPage = await engine.load<{ readonly title: string }>(fixture.page, { layout: 'main.htmv' });
    assert.match(renderChangedPage({ title: 'Changed' }), /<main>changed<\/main>/);
  });

  it('can disable parsed-template caching', async (context) => {
    const fixture = await createFixture(context);
    const engine = new TemplateEngine({ layoutPath: fixture.layouts, cache: false });

    const first = await engine.load(fixture.page);
    assert.match(first({ title: 'First', projects: [] }), /<h1>First<\/h1>/);

    await writeFile(fixture.page, '<p>{{ title }}</p>', 'utf8');
    const second = await engine.load(fixture.page);
    assert.equal(second({ title: 'Second' }), '<p>Second</p>');
  });

  it('requires one layout content slot and no feature content slots', async (context) => {
    const fixture = await createFixture(context);
    const engine = new TemplateEngine({ layoutPath: fixture.layouts });

    await writeFile(join(fixture.layouts, 'empty.htmv'), '<html></html>', 'utf8');
    await assert.rejects(() => engine.load(fixture.page, { layout: 'empty.htmv' }), /must contain exactly one content slot, found 0/);

    await writeFile(fixture.page, '{% content %}', 'utf8');
    engine.clearCache();
    await assert.rejects(() => engine.load(fixture.page), /must contain no content slots, found 1/);
  });

  it('prevents layouts from escaping layoutPath', async (context) => {
    const fixture = await createFixture(context);
    const engine = new TemplateEngine({ layoutPath: fixture.layouts });

    await assert.rejects(
      () => engine.load(fixture.page, { layout: '../outside.htmv' }),
      (error: unknown) => {
        assert.ok(error instanceof TemplateLoadingError);
        assert.match(error.message, /resolves outside/);
        return true;
      },
    );
  });

  it('honors an already-aborted load signal', async (context) => {
    const fixture = await createFixture(context);
    const engine = new TemplateEngine({ layoutPath: fixture.layouts });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => engine.load(fixture.page, { signal: controller.signal }), { name: 'AbortError' });
  });

  it('validates public configuration eagerly', () => {
    assert.throws(() => new TemplateEngine({ layoutPath: '' }), /layoutPath cannot be empty/);
    assert.throws(() => new TemplateEngine({ layoutPath: new URL('https://example.com/layouts/') }), /file protocol/);
  });
});

interface Fixture {
  readonly root: string;
  readonly layouts: string;
  readonly page: string;
}

async function createFixture(context: { after(callback: () => Promise<void>): void }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'mvv-template-'));
  const layouts = join(root, 'layouts');
  const features = join(root, 'features');
  const page = join(features, 'page.htmv');

  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(layouts);
  await mkdir(features);
  await writeFile(join(layouts, 'main.htmv'), '<!doctype html>\n<title>{{ title }}</title>\n{% content %}', 'utf8');
  await writeFile(join(root, 'outside.htmv'), '{% content %}', 'utf8');
  await writeFile(page, '<main>\n<h1>{{ title }}</h1>\n{% for project in projects %}<p>{{ loop.index }}: {{ project }}</p>{% endfor %}\n</main>', 'utf8');

  return { root, layouts, page };
}
