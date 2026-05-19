function stripBlockTag(input: string, tagName: 'script' | 'style'): string {
  const lower = input.toLowerCase();
  const open = `<${tagName}`;
  const close = `</${tagName}`;

  let output = '';
  let index = 0;

  while (index < input.length) {
    const openIndex = lower.indexOf(open, index);
    if (openIndex === -1) {
      output += input.slice(index);
      break;
    }

    output += input.slice(index, openIndex);

    const openEnd = lower.indexOf('>', openIndex + open.length);
    if (openEnd === -1) {
      output += ' ';
      break;
    }

    const closeStart = lower.indexOf(close, openEnd + 1);
    if (closeStart === -1) {
      output += ' ';
      break;
    }

    const closeEnd = lower.indexOf('>', closeStart + close.length);
    if (closeEnd === -1) {
      output += ' ';
      break;
    }

    output += ' ';
    index = closeEnd + 1;
  }

  return output;
}

function removeHtmlTags(input: string): string {
  let output = '';
  let inTag = false;

  for (const ch of input) {
    if (ch === '<') {
      inTag = true;
      continue;
    }
    if (ch === '>') {
      inTag = false;
      output += ' ';
      continue;
    }
    if (!inTag) {
      output += ch;
    }
  }

  return output;
}

export function stripHtmlToText(value: string): string {
  const withoutStyle = stripBlockTag(value, 'style');
  const withoutScript = stripBlockTag(withoutStyle, 'script');
  const withoutTags = removeHtmlTags(withoutScript);

  return withoutTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
