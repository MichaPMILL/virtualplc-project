// Small XML parser (elements, attributes and text), enough for engineering exchange files
// (IODD device descriptions, SimaticML / Openness exports). No DTD, no external entities.

export interface XmlNode {
  /** Element name without namespace prefix */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Text content directly inside the element (unescaped, CDATA included) */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]);

export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m.index! > last) top.text += unescapeXml(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      top.text += m[1];
      continue;
    }
    if (m[2]) {
      const name = m[2].replace(/^[\w.-]+:/, '');
      if (stack.length > 1 && top.name === name) stack.pop();
      continue;
    }
    if (!m[3]) continue;
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescapeXml(a[2] ?? a[3] ?? '');
    const node: XmlNode = { name: m[3].replace(/^[\w.-]+:/, ''), attrs, children: [], text: '' };
    top.children.push(node);
    if (!m[5]) stack.push(node);
  }
  return root;
}

export function* walkXml(n: XmlNode): Generator<XmlNode> {
  yield n;
  for (const c of n.children) yield* walkXml(c);
}

/** First descendant (or the node itself) with this name. */
export const findXml = (n: XmlNode | undefined, name: string): XmlNode | undefined => {
  if (!n) return undefined;
  for (const x of walkXml(n)) if (x.name === name) return x;
  return undefined;
};

/** Direct child with this name. */
export const childXml = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
export const childrenXml = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
