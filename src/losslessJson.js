class JsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const root = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail();
    return root;
  }

  fail() {
    throw new Error('Invalid JSON.');
  }

  skipWhitespace() {
    while (
      this.source[this.index] === ' '
      || this.source[this.index] === '\t'
      || this.source[this.index] === '\r'
      || this.source[this.index] === '\n'
    ) {
      this.index += 1;
    }
  }

  parseValue() {
    const character = this.source[this.index];
    if (character === '{') return this.parseObject();
    if (character === '[') return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === '-' || (character >= '0' && character <= '9')) return this.parseNumber();
    if (this.source.startsWith('true', this.index)) return this.parseLiteral('true', true);
    if (this.source.startsWith('false', this.index)) return this.parseLiteral('false', false);
    if (this.source.startsWith('null', this.index)) return this.parseLiteral('null', null);
    return this.fail();
  }

  parseObject() {
    const start = this.index;
    this.index += 1;
    this.skipWhitespace();
    const properties = [];
    if (this.source[this.index] === '}') {
      this.index += 1;
      return { type: 'object', start, end: this.index, properties };
    }

    while (this.index < this.source.length) {
      if (this.source[this.index] !== '"') this.fail();
      const keyNode = this.parseString();
      this.skipWhitespace();
      if (this.source[this.index] !== ':') this.fail();
      this.index += 1;
      this.skipWhitespace();
      const value = this.parseValue();
      properties.push({
        key: keyNode.value,
        keyNode,
        value,
        start: keyNode.start,
        end: value.end,
      });
      this.skipWhitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return { type: 'object', start, end: this.index, properties };
      }
      if (this.source[this.index] !== ',') this.fail();
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === '}') this.fail();
    }
    return this.fail();
  }

  parseArray() {
    const start = this.index;
    this.index += 1;
    this.skipWhitespace();
    const items = [];
    if (this.source[this.index] === ']') {
      this.index += 1;
      return { type: 'array', start, end: this.index, items };
    }

    while (this.index < this.source.length) {
      items.push(this.parseValue());
      this.skipWhitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return { type: 'array', start, end: this.index, items };
      }
      if (this.source[this.index] !== ',') this.fail();
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === ']') this.fail();
    }
    return this.fail();
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        const raw = this.source.slice(start, this.index);
        try {
          return { type: 'string', start, end: this.index, value: JSON.parse(raw) };
        } catch {
          return this.fail();
        }
      }
      if (character === '\\') {
        this.index += 1;
        const escaped = this.source[this.index];
        if (escaped === 'u') {
          for (let count = 0; count < 4; count += 1) {
            this.index += 1;
            const hex = this.source[this.index];
            const isHex = (hex >= '0' && hex <= '9')
              || (hex >= 'a' && hex <= 'f')
              || (hex >= 'A' && hex <= 'F');
            if (!isHex) this.fail();
          }
          this.index += 1;
          continue;
        }
        if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escaped)) this.fail();
        this.index += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) <= 0x1f) this.fail();
      this.index += 1;
    }
    return this.fail();
  }

  parseNumber() {
    const start = this.index;
    if (this.source[this.index] === '-') this.index += 1;
    if (this.source[this.index] === '0') {
      this.index += 1;
      if (this.source[this.index] >= '0' && this.source[this.index] <= '9') this.fail();
    } else {
      if (this.source[this.index] < '1' || this.source[this.index] > '9') this.fail();
      while (this.source[this.index] >= '0' && this.source[this.index] <= '9') this.index += 1;
    }
    if (this.source[this.index] === '.') {
      this.index += 1;
      if (this.source[this.index] < '0' || this.source[this.index] > '9') this.fail();
      while (this.source[this.index] >= '0' && this.source[this.index] <= '9') this.index += 1;
    }
    if (this.source[this.index] === 'e' || this.source[this.index] === 'E') {
      this.index += 1;
      if (this.source[this.index] === '+' || this.source[this.index] === '-') this.index += 1;
      if (this.source[this.index] < '0' || this.source[this.index] > '9') this.fail();
      while (this.source[this.index] >= '0' && this.source[this.index] <= '9') this.index += 1;
    }
    return {
      type: 'number',
      start,
      end: this.index,
      raw: this.source.slice(start, this.index),
    };
  }

  parseLiteral(raw, value) {
    const start = this.index;
    this.index += raw.length;
    return { type: 'literal', start, end: this.index, value };
  }
}

export function parseLosslessJson(source) {
  const preservedSource = source.trim() ? source : `${source}{}`;
  return {
    originalSource: source,
    source: preservedSource,
    root: new JsonParser(preservedSource).parse(),
  };
}

export function propertiesNamed(objectNode, key) {
  if (objectNode?.type !== 'object') return [];
  return objectNode.properties.filter(property => property.key === key);
}

export function nodeMatchesValue(node, value) {
  if (value === null || typeof value === 'boolean') {
    return node?.type === 'literal' && node.value === value;
  }
  if (typeof value === 'string') return node?.type === 'string' && node.value === value;
  if (typeof value === 'number') return node?.type === 'number' && node.raw === String(value);
  if (Array.isArray(value)) {
    return node?.type === 'array'
      && node.items.length === value.length
      && node.items.every((item, index) => nodeMatchesValue(item, value[index]));
  }
  if (!value || typeof value !== 'object' || node?.type !== 'object') return false;
  const keys = Object.keys(value);
  if (node.properties.length !== keys.length) return false;
  return keys.every(key => {
    const matches = propertiesNamed(node, key);
    return matches.length === 1 && nodeMatchesValue(matches[0].value, value[key]);
  });
}

export function stringArrayNodeValues(node) {
  if (node?.type !== 'array' || node.items.some(item => item.type !== 'string')) return undefined;
  return node.items.map(item => item.value);
}

export function propertyRemovalEdits(objectNode, properties) {
  if (!properties.length) return [];
  const indexes = [...new Set(properties.map(property => objectNode.properties.indexOf(property)))]
    .filter(index => index >= 0)
    .sort((left, right) => left - right);
  const edits = [];
  let runStart = indexes[0];
  let runEnd = indexes[0];

  const addRun = () => {
    const all = objectNode.properties;
    if (runStart === 0) {
      edits.push({
        start: all[runStart].start,
        end: runEnd === all.length - 1 ? all[runEnd].end : all[runEnd + 1].start,
        text: '',
      });
    } else {
      edits.push({
        start: all[runStart - 1].end,
        end: all[runEnd].end,
        text: '',
      });
    }
  };

  for (const index of indexes.slice(1)) {
    if (index === runEnd + 1) {
      runEnd = index;
      continue;
    }
    addRun();
    runStart = index;
    runEnd = index;
  }
  addRun();
  return edits;
}

export function propertyInsertionsEdit(objectNode, entries, remainingPropertyCount) {
  if (!entries.length) return undefined;
  return {
    start: objectNode.end - 1,
    end: objectNode.end - 1,
    text: `${remainingPropertyCount ? ',' : ''}${entries
      .map(([key, valueText]) => `${JSON.stringify(key)}:${valueText}`)
      .join(',')}`,
  };
}

export function propertyInsertionEdit(objectNode, key, valueText, remainingPropertyCount) {
  return propertyInsertionsEdit(objectNode, [[key, valueText]], remainingPropertyCount);
}

export function applyJsonEdits(source, edits) {
  const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
  let next = source;
  let previousStart = source.length + 1;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length || edit.end > previousStart) {
      throw new Error('JSON edits overlap; refusing to modify the config.');
    }
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
    previousStart = edit.start;
  }
  return next;
}
