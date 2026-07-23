import OpenCC from 'opencc-js';

const simplifiedToTaiwanTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

export function toTraditionalChineseText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  return simplifiedToTaiwanTraditional(text);
}
