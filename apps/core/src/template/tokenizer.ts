export const TEMPLATE_TOKENS = {
  TEXT: 'text',
  INTERPOLATION: 'interpolation',
  STATEMENT: 'statement',
  INTERPOLATION_START: '{{',
  INTERPOLATION_END: '}}',
  STATEMENT_START: '{%',
  STATEMENT_END: '%}',
} as const;

const SCRIPT_START_PATTERN = /<script(?=[\s/>])/giu;
const SCRIPT_END_PATTERN = /<\/script\s*>/giu;

export interface SourceLocation {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export type TemplateToken =
  | { readonly kind: typeof TEMPLATE_TOKENS.TEXT; readonly value: string; readonly location: SourceLocation }
  | { readonly kind: typeof TEMPLATE_TOKENS.INTERPOLATION; readonly value: string; readonly location: SourceLocation }
  | { readonly kind: typeof TEMPLATE_TOKENS.STATEMENT; readonly value: string; readonly location: SourceLocation };

export class TemplateTokenizationError extends SyntaxError {
  public readonly location: SourceLocation;

  public constructor(message: string, location: SourceLocation) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = 'TemplateTokenizationError';
    this.location = location;
  }
}

export function tokenizeTemplate(source: string): readonly TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const getLocation = (): SourceLocation => ({ offset, line, column });
  const advanceTo = (targetOffset: number): void => {
    while (offset < targetOffset) {
      if (source[offset] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }

      offset += 1;
    }
  };

  while (offset < source.length) {
    const interpolationOffset = source.indexOf(TEMPLATE_TOKENS.INTERPOLATION_START, offset);
    const statementOffset = source.indexOf(TEMPLATE_TOKENS.STATEMENT_START, offset);
    const scriptOffset = findNextScriptOffset(source, offset);
    const openingOffset = findNextOpeningOffset(interpolationOffset, statementOffset, scriptOffset);

    if (openingOffset === -1) {
      tokens.push({ kind: TEMPLATE_TOKENS.TEXT, value: source.slice(offset), location: getLocation() });
      break;
    }

    if (openingOffset > offset) {
      const location = getLocation();
      tokens.push({ kind: TEMPLATE_TOKENS.TEXT, value: source.slice(offset, openingOffset), location });
      advanceTo(openingOffset);
    }

    const location = getLocation();
    if (openingOffset === scriptOffset) {
      const scriptEndOffset = findScriptEndOffset(source, offset);
      if (scriptEndOffset === -1) throw new TemplateTokenizationError('Unclosed <script> element', location);

      tokens.push({ kind: TEMPLATE_TOKENS.TEXT, value: source.slice(offset, scriptEndOffset), location });
      advanceTo(scriptEndOffset);
      continue;
    }

    const kind = source.startsWith(TEMPLATE_TOKENS.INTERPOLATION_START, offset) ? TEMPLATE_TOKENS.INTERPOLATION : TEMPLATE_TOKENS.STATEMENT;
    const openingDelimiter = kind === TEMPLATE_TOKENS.INTERPOLATION ? TEMPLATE_TOKENS.INTERPOLATION_START : TEMPLATE_TOKENS.STATEMENT_START;
    const closingDelimiter = kind === TEMPLATE_TOKENS.INTERPOLATION ? TEMPLATE_TOKENS.INTERPOLATION_END : TEMPLATE_TOKENS.STATEMENT_END;
    const contentOffset = offset + openingDelimiter.length;
    const closingOffset = source.indexOf(closingDelimiter, contentOffset);

    if (closingOffset === -1) throw new TemplateTokenizationError(`Unclosed ${kind}`, location);

    tokens.push({ kind, value: source.slice(contentOffset, closingOffset).trim(), location });
    advanceTo(closingOffset + closingDelimiter.length);
  }

  return tokens;
}

function findNextOpeningOffset(...offsets: readonly number[]): number {
  let nextOffset = -1;

  for (const offset of offsets) {
    if (offset !== -1 && (nextOffset === -1 || offset < nextOffset)) nextOffset = offset;
  }

  return nextOffset;
}

function findNextScriptOffset(source: string, offset: number): number {
  SCRIPT_START_PATTERN.lastIndex = offset;
  return SCRIPT_START_PATTERN.exec(source)?.index ?? -1;
}

function findScriptEndOffset(source: string, scriptOffset: number): number {
  const openingTagEndOffset = findOpeningTagEndOffset(source, scriptOffset);
  if (openingTagEndOffset === -1) return -1;

  SCRIPT_END_PATTERN.lastIndex = openingTagEndOffset;
  const closingTag = SCRIPT_END_PATTERN.exec(source);
  if (closingTag === null) return -1;

  return closingTag.index + closingTag[0].length;
}

function findOpeningTagEndOffset(source: string, openingTagOffset: number): number {
  let quote: '"' | "'" | undefined;

  for (let offset = openingTagOffset; offset < source.length; offset += 1) {
    const character = source[offset];

    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }

    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return offset + 1;
  }

  return -1;
}
