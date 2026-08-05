const PROTECTED_BLOCK_PATTERN = /<(pre|textarea|script)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const NEWLINE_WITH_INDENTATION_PATTERN = /[ \t]*\r?\n[ \t\r\n]*/g;

export function stripHtmlWhitespace(html: string): string {
  let output = '';
  let offset = 0;

  for (const match of html.matchAll(PROTECTED_BLOCK_PATTERN)) {
    const matchOffset = match.index;
    output += stripUnprotectedWhitespace(html.slice(offset, matchOffset));
    output += match[0];
    offset = matchOffset + match[0].length;
  }

  output += stripUnprotectedWhitespace(html.slice(offset));
  return output.trim();
}

function stripUnprotectedWhitespace(html: string): string {
  return html.replace(NEWLINE_WITH_INDENTATION_PATTERN, (whitespace, offset: number) => {
    const before = html[offset - 1];
    const after = html[offset + whitespace.length];

    if (before === undefined || after === undefined) return '';
    if (before === '>' && after === '<') return '';
    if (before === '>' || after === '<') return '';
    return ' ';
  });
}
