import { evaluateExpression, ExpressionEvaluationError, isTruthy, type ExpressionScope } from './expression-evaluator.js';
import { TEMPLATE_STATEMENTS, type TemplateNode } from './parser.js';
import { TEMPLATE_TOKENS, type SourceLocation } from './tokenizer.js';
import { stripHtmlWhitespace } from './whitespace.js';

export interface TemplateRenderOptions {
  readonly content?: string;
  readonly stripWhitespace?: boolean;
}

export class TemplateRenderingError extends Error {
  public readonly location: SourceLocation;

  public constructor(message: string, location: SourceLocation, options?: ErrorOptions) {
    super(`${message} at template line ${location.line}, column ${location.column}`, options);
    this.name = 'TemplateRenderingError';
    this.location = location;
  }
}

export function renderTemplate(nodes: readonly TemplateNode[], data: object, options: TemplateRenderOptions = {}): string {
  if (data === null || typeof data !== 'object') throw new TypeError('Template data must be an object');

  const chunks: string[] = [];
  renderNodes(nodes, { values: data }, chunks, options.content);
  const html = chunks.join('');
  return options.stripWhitespace === true ? stripHtmlWhitespace(html) : html;
}

function renderNodes(nodes: readonly TemplateNode[], scope: ExpressionScope, chunks: string[], content: string | undefined): void {
  for (const node of nodes) {
    if (node.kind === TEMPLATE_TOKENS.TEXT) {
      chunks.push(node.value);
      continue;
    }

    if (node.kind === TEMPLATE_TOKENS.INTERPOLATION) {
      chunks.push(escapeHtml(formatInterpolation(evaluateAt(node.compiledExpression, scope, node.location), node.location)));
      continue;
    }

    if (node.kind === TEMPLATE_STATEMENTS.CONTENT) {
      if (content === undefined) throw new TemplateRenderingError('The "content" slot can only be rendered by a layout', node.location);
      chunks.push(content);
      continue;
    }

    if (node.kind === TEMPLATE_STATEMENTS.IF) {
      const branch = node.branches.find((candidate) => isTruthy(evaluateAt(candidate.compiledCondition, scope, candidate.location)));
      if (branch !== undefined) renderNodes(branch.body, scope, chunks, content);
      else if (node.elseBody !== undefined) renderNodes(node.elseBody, scope, chunks, content);
      continue;
    }

    const iterable = evaluateAt(node.compiledIterableExpression, scope, node.location);
    if (!Array.isArray(iterable)) throw new TemplateRenderingError(`Loop expression "${node.iterableExpression}" must resolve to an array`, node.location);

    for (let index = 0; index < iterable.length; index += 1) {
      const loop = Object.freeze({ index: index + 1, index0: index, first: index === 0, last: index === iterable.length - 1, length: iterable.length });
      const values = { [node.itemName]: iterable[index], loop };
      renderNodes(node.body, { values, parent: scope }, chunks, content);
    }
  }
}

function evaluateAt(expression: Parameters<typeof evaluateExpression>[0], scope: ExpressionScope, location: SourceLocation): unknown {
  try {
    return evaluateExpression(expression, scope);
  } catch (error) {
    if (!(error instanceof ExpressionEvaluationError)) throw error;
    throw new TemplateRenderingError(error.message, location, { cause: error });
  }
}

function formatInterpolation(value: unknown, location: SourceLocation): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new TemplateRenderingError(`Cannot interpolate a value of type "${typeof value}"`, location);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
}
