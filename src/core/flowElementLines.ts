import { EXECUTABLE_ELEMENT_TYPES } from './flowFingerprint.js';

/** An executable Flow element and the line of its `<name>` in the source file. */
export type FlowElementLine = {
  name: string;
  /** Singular element type, such as `decision`. */
  type: string;
  /** 1-based line of the element's `<name>` tag. */
  line: number;
};

// Tags, plus the constructs that can contain `<` without being tags.
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g;

/**
 * Finds each executable element in a Flow metadata file and the line its name is on, in file
 * order. Coverage formats need a line per element; the name line identifies the element.
 */
export function flowElementLines(xml: string): FlowElementLine[] {
  const elements: FlowElementLine[] = [];
  let depth = 0;
  let line = 1;
  let scanned = 0;
  let current: { type: string; name?: string; line?: number } | undefined;
  for (const match of xml.matchAll(TOKEN)) {
    const [token, closing, tag, selfClosing] = match;
    const index = match.index;
    for (let i = scanned; i < index; i++) if (xml.charCodeAt(i) === 10) line++;
    scanned = index;
    if (!tag) continue;
    if (closing) {
      depth--;
      if (depth === 1 && current) {
        if (current.name && current.line) elements.push({ name: current.name, type: current.type, line: current.line });
        current = undefined;
      }
      continue;
    }
    if (depth === 1 && EXECUTABLE_ELEMENT_TYPES.has(tag)) current = { type: tag.replace(/s$/, '') };
    if (depth === 2 && current && tag === 'name' && !selfClosing) {
      const end = xml.indexOf('<', index + token.length);
      current.name = xml.slice(index + token.length, end === -1 ? undefined : end).trim();
      current.line = line;
    }
    if (!selfClosing) depth++;
  }
  return elements;
}
