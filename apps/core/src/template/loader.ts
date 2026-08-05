import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTemplate, type TemplateNode } from './parser.js';
import { tokenizeTemplate } from './tokenizer.js';

export class TemplateLoadingError extends Error {
  public readonly templatePath: string;

  public constructor(message: string, templatePath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TemplateLoadingError';
    this.templatePath = templatePath;
  }
}

export function resolveTemplatePath(templatePath: string | URL): string {
  if (templatePath instanceof URL) {
    if (templatePath.protocol !== 'file:') throw new TypeError(`Template URLs must use the file protocol, received "${templatePath.protocol}"`);
    return fileURLToPath(templatePath);
  }

  if (templatePath.trim().length === 0) throw new TypeError('Template path cannot be empty');
  return resolve(templatePath);
}

export async function resolveLayoutTemplatePath(layoutPath: string, layoutName: string): Promise<string> {
  if (layoutName.trim().length === 0) throw new TypeError('Layout name cannot be empty');
  if (isAbsolute(layoutName)) throw new TypeError('Layout names must be relative to layoutPath');

  const unresolvedTemplatePath = resolve(layoutPath, layoutName);
  assertPathContained(layoutPath, unresolvedTemplatePath, layoutName);

  try {
    const canonicalLayoutPath = await realpath(layoutPath);
    const canonicalTemplatePath = await realpath(unresolvedTemplatePath);
    assertPathContained(canonicalLayoutPath, canonicalTemplatePath, layoutName);
    return canonicalTemplatePath;
  } catch (error) {
    if (error instanceof TemplateLoadingError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new TemplateLoadingError(`Failed to resolve layout "${layoutName}": ${message}`, unresolvedTemplatePath, { cause: error });
  }
}

export async function loadTemplateAst(templatePath: string, signal?: AbortSignal): Promise<readonly TemplateNode[]> {
  try {
    const source = await readFile(templatePath, { encoding: 'utf8', signal });
    return parseTemplate(tokenizeTemplate(source));
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new TemplateLoadingError(`Failed to load template "${templatePath}": ${message}`, templatePath, { cause: error });
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function assertPathContained(layoutPath: string, templatePath: string, layoutName: string): void {
  const relativeTemplatePath = relative(layoutPath, templatePath);
  if (!relativeTemplatePath.startsWith('..') && !isAbsolute(relativeTemplatePath)) return;
  throw new TemplateLoadingError(`Layout "${layoutName}" resolves outside the configured layoutPath`, templatePath);
}
