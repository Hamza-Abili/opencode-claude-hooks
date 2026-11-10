/**
 * Tiny YAML subset parser for Markdown frontmatter when Bun.YAML is not
 * available (for example the Node-built doctor CLI). It supports the shapes
 * Claude uses in SKILL.md/agent frontmatter: nested maps, lists, quoted and
 * plain scalars, booleans, null, numbers and `|`/`>` blocks.
 */

interface Line {
  readonly indent: number;
  readonly text: string;
}

function scalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (value === "null" || value === "Null" || value === "NULL" || value === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("{") && value.endsWith("}"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function splitKey(text: string): { key: string; rest: string } | undefined {
  const colon = text.indexOf(":");
  if (colon <= 0) return undefined;
  const key = text.slice(0, colon).trim();
  if (key.length === 0) return undefined;
  return { key, rest: text.slice(colon + 1).trim() };
}

function parseLines(source: string): Line[] {
  const output: Line[] = [];
  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) continue;
    if (raw.includes("\t") && raw.trimStart() !== raw) continue;
    const indent = raw.length - raw.trimStart().length;
    output.push({ indent, text: raw.trimEnd().slice(indent) });
  }
  return output;
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number
): { value: unknown; next: number } {
  const first = lines[start];
  if (first === undefined || first.indent < indent) return { value: null, next: start };
  if (first.text.startsWith("- ") || first.text === "-") return parseList(lines, start, indent);
  return parseMap(lines, start, indent);
}

interface BlockIndicator {
  readonly folded: boolean;
  readonly chomp: "-" | "+" | "";
}

function blockIndicator(rest: string): BlockIndicator | undefined {
  const match = /^([|>])([+-]?)$/.exec(rest);
  if (match === null) return undefined;
  return { folded: match[1] === ">", chomp: (match[2] ?? "") as "-" | "+" | "" };
}

function parseBlockScalar(
  lines: Line[],
  start: number,
  parentIndent: number,
  indicator: BlockIndicator
): { value: string; next: number } {
  const parts: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.indent <= parentIndent) break;
    parts.push(line.text);
    index += 1;
  }
  let value = parts.join(indicator.folded ? " " : "\n");
  if (indicator.chomp !== "-" && value.length > 0) value += "\n";
  return { value, next: index };
}

function parseMap(
  lines: Line[],
  start: number,
  indent: number
): { value: Record<string, unknown>; next: number } {
  const output: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.indent < indent) break;
    if (line.indent > indent) break;
    if (line.text.startsWith("- ") || line.text === "-") break;
    const pair = splitKey(line.text);
    if (pair === undefined) {
      index += 1;
      continue;
    }
    const indicator = blockIndicator(pair.rest);
    if (indicator !== undefined) {
      const block = parseBlockScalar(lines, index + 1, indent, indicator);
      output[pair.key] = block.value;
      index = block.next;
      continue;
    }
    if (pair.rest === "") {
      const nextLine = lines[index + 1];
      if (nextLine !== undefined && nextLine.indent > indent) {
        const block = parseBlock(lines, index + 1, nextLine.indent);
        output[pair.key] = block.value;
        index = block.next;
      } else {
        output[pair.key] = null;
        index += 1;
      }
      continue;
    }
    output[pair.key] = scalar(pair.rest);
    index += 1;
  }
  return { value: output, next: index };
}

function parseList(
  lines: Line[],
  start: number,
  indent: number
): { value: unknown[]; next: number } {
  const output: unknown[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.indent !== indent) break;
    if (!line.text.startsWith("- ") && line.text !== "-") break;
    const content = line.text.slice(2).trim();
    if (content.length === 0) {
      const nextLine = lines[index + 1];
      if (nextLine !== undefined && nextLine.indent > indent) {
        const block = parseBlock(lines, index + 1, nextLine.indent);
        output.push(block.value);
        index = block.next;
      } else {
        output.push(null);
        index += 1;
      }
      continue;
    }
    const pair = splitKey(content);
    if (pair === undefined) {
      output.push(scalar(content));
      index += 1;
      continue;
    }
    // A list item that starts with `key: value` is a map; following lines at
    // the item's content indentation continue that map.
    const itemIndent = indent + 2;
    const item: Record<string, unknown> = {};
    const firstIndicator = blockIndicator(pair.rest);
    if (firstIndicator !== undefined) {
      const block = parseBlockScalar(lines, index + 1, indent, firstIndicator);
      item[pair.key] = block.value;
      index = block.next;
      while (index < lines.length) {
        const following = lines[index];
        if (following === undefined) break;
        if (following.indent !== itemIndent) break;
        if (following.text.startsWith("- ")) break;
        const nestedPair = splitKey(following.text);
        if (nestedPair === undefined) break;
        const nestedIndicator = blockIndicator(nestedPair.rest);
        if (nestedIndicator !== undefined) {
          const nestedBlock = parseBlockScalar(lines, index + 1, itemIndent, nestedIndicator);
          item[nestedPair.key] = nestedBlock.value;
          index = nestedBlock.next;
        } else if (nestedPair.rest === "") {
          const nextLine = lines[index + 1];
          if (nextLine !== undefined && nextLine.indent > itemIndent) {
            const block = parseBlock(lines, index + 1, nextLine.indent);
            item[nestedPair.key] = block.value;
            index = block.next;
          } else {
            item[nestedPair.key] = null;
            index += 1;
          }
        } else {
          item[nestedPair.key] = scalar(nestedPair.rest);
          index += 1;
        }
      }
      output.push(item);
      continue;
    }
    if (pair.rest === "") {
      const nextLine = lines[index + 1];
      if (nextLine !== undefined && nextLine.indent > itemIndent) {
        const block = parseBlock(lines, index + 1, nextLine.indent);
        item[pair.key] = block.value;
        index = block.next;
      } else {
        item[pair.key] = null;
        index += 1;
      }
    } else {
      item[pair.key] = scalar(pair.rest);
      index += 1;
    }
    while (index < lines.length) {
      const following = lines[index];
      if (following === undefined) break;
      if (following.indent !== itemIndent) break;
      if (following.text.startsWith("- ")) break;
      const nestedPair = splitKey(following.text);
      if (nestedPair === undefined) break;
      const nestedIndicator = blockIndicator(nestedPair.rest);
      if (nestedIndicator !== undefined) {
        const nestedBlock = parseBlockScalar(lines, index + 1, itemIndent, nestedIndicator);
        item[nestedPair.key] = nestedBlock.value;
        index = nestedBlock.next;
      } else if (nestedPair.rest === "") {
        const nextLine = lines[index + 1];
        if (nextLine !== undefined && nextLine.indent > itemIndent) {
          const block = parseBlock(lines, index + 1, nextLine.indent);
          item[nestedPair.key] = block.value;
          index = block.next;
        } else {
          item[nestedPair.key] = null;
          index += 1;
        }
      } else {
        item[nestedPair.key] = scalar(nestedPair.rest);
        index += 1;
      }
    }
    output.push(item);
  }
  return { value: output, next: index };
}

export function parseSimpleYaml(source: string): unknown {
  const lines = parseLines(source);
  if (lines.length === 0) return {};
  const first = lines[0];
  return first === undefined ? {} : parseBlock(lines, 0, first.indent).value;
}
