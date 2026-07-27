import OpenCC from 'opencc-js';

const simplifiedToTaiwanTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

export function toTraditionalChineseText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  return simplifiedToTaiwanTraditional(text);
}

export function toTraditionalChineseSourceContent(content) {
  if (!content || typeof content !== 'object') {
    return content;
  }

  return {
    ...content,
    ...(typeof content.text === 'string' ? { text: toTraditionalChineseText(content.text) } : {}),
    ...(Array.isArray(content.paragraphs)
      ? { paragraphs: content.paragraphs.map(toTraditionalChineseText) }
      : {})
  };
}
