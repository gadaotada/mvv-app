import { loadTemplateAst, resolveLayoutTemplatePath, resolveTemplatePath, TemplateLoadingError } from './loader.js';
import { TEMPLATE_STATEMENTS, type TemplateNode } from './parser.js';
import { renderTemplate, TemplateRenderingError } from './renderer.js';
import { stripHtmlWhitespace } from './whitespace.js';

export interface TemplateEngineOptions {
  readonly layoutPath: string | URL;
  readonly stripWhitespace?: boolean;
  readonly cache?: boolean;
}

export interface TemplateLoadOptions {
  readonly layout?: string;
  readonly signal?: AbortSignal;
}

export type TemplateRenderer<TData extends object> = (data: Readonly<TData>) => string;

export class TemplateEngine {
  public readonly options: TemplateEngineOptions;
  private readonly resolvedLayoutPath: string;
  private readonly parsedTemplates = new Map<string, readonly TemplateNode[]>();

  public constructor(options: TemplateEngineOptions) {
    validateOptions(options);
    this.options = Object.freeze({ ...options });
    this.resolvedLayoutPath = resolveTemplatePath(options.layoutPath);
  }

  public async load<TData extends object>(templatePath: string | URL, options?: TemplateLoadOptions): Promise<TemplateRenderer<TData>> {
    options?.signal?.throwIfAborted();

    const resolvedTemplatePath = resolveTemplatePath(templatePath);
    const template = await this.loadAst(resolvedTemplatePath, options?.signal);
    assertContentSlotCount(template, 0, resolvedTemplatePath);

    let layout: readonly TemplateNode[] | undefined;
    if (options?.layout !== undefined) {
      const resolvedLayoutTemplatePath = await resolveLayoutTemplatePath(this.resolvedLayoutPath, options.layout);
      options.signal?.throwIfAborted();
      layout = await this.loadAst(resolvedLayoutTemplatePath, options.signal);
      assertContentSlotCount(layout, 1, resolvedLayoutTemplatePath);
    }

    const shouldStripWhitespace = this.options.stripWhitespace === true;
    return (data: Readonly<TData>): string => {
      const content = renderTemplate(template, data);
      const html = layout === undefined ? content : renderTemplate(layout, data, { content });
      return shouldStripWhitespace ? stripHtmlWhitespace(html) : html;
    };
  }

  public clearCache(): void {
    this.parsedTemplates.clear();
  }

  private async loadAst(templatePath: string, signal?: AbortSignal): Promise<readonly TemplateNode[]> {
    if (this.options.cache !== false) {
      const cached = this.parsedTemplates.get(templatePath);
      if (cached !== undefined) return cached;
    }

    const template = await loadTemplateAst(templatePath, signal);
    if (this.options.cache !== false) this.parsedTemplates.set(templatePath, template);
    return template;
  }
}

export { TemplateLoadingError, TemplateRenderingError };

function validateOptions(options: TemplateEngineOptions): void {
  if (options === null || typeof options !== 'object') throw new TypeError('Template engine options must be an object');
  if (!(typeof options.layoutPath === 'string' || options.layoutPath instanceof URL)) throw new TypeError('layoutPath must be a filesystem path or file URL');
  if (typeof options.layoutPath === 'string' && options.layoutPath.trim().length === 0) throw new TypeError('layoutPath cannot be empty');
  if (options.stripWhitespace !== undefined && typeof options.stripWhitespace !== 'boolean') throw new TypeError('stripWhitespace must be a boolean');
  if (options.cache !== undefined && typeof options.cache !== 'boolean') throw new TypeError('cache must be a boolean');
}

function assertContentSlotCount(nodes: readonly TemplateNode[], expectedCount: 0 | 1, templatePath: string): void {
  const actualCount = countContentSlots(nodes);
  if (actualCount === expectedCount) return;

  const expected = expectedCount === 0 ? 'no content slots' : 'exactly one content slot';
  throw new TemplateLoadingError(`Template "${templatePath}" must contain ${expected}, found ${actualCount}`, templatePath);
}

function countContentSlots(nodes: readonly TemplateNode[]): number {
  let count = 0;

  for (const node of nodes) {
    if (node.kind === TEMPLATE_STATEMENTS.CONTENT) count += 1;
    else if (node.kind === TEMPLATE_STATEMENTS.FOR) count += countContentSlots(node.body);
    else if (node.kind === TEMPLATE_STATEMENTS.IF) {
      for (const branch of node.branches) count += countContentSlots(branch.body);
      if (node.elseBody !== undefined) count += countContentSlots(node.elseBody);
    }
  }

  return count;
}
