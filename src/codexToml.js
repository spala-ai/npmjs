import fs from 'node:fs';
import { assertSafePath } from './pathSafety.js';

const UNSUPPORTED_HEADER_ERROR = 'Codex config contains a TOML table header this installer cannot safely preserve.';
const UNSUPPORTED_KEY_VALUE_ERROR = 'Codex config contains a TOML key/value statement this installer cannot safely preserve.';

function unsupportedHeader() {
  throw new Error(UNSUPPORTED_HEADER_ERROR);
}

function unsupportedKeyValue() {
  throw new Error(UNSUPPORTED_KEY_VALUE_ERROR);
}

function isInlineWhitespace(character) {
  return character === ' ' || character === '\t';
}

function isBareKeyCharacter(character) {
  return /[A-Za-z0-9_-]/.test(character);
}

function decodeUnicodeEscape(raw, unsupported) {
  if (!/^[0-9A-Fa-f]+$/.test(raw)) unsupported();
  const codePoint = Number.parseInt(raw, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) unsupported();
  return String.fromCodePoint(codePoint);
}

function readBasicKey(text, start, unsupported = unsupportedHeader) {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') return { value, end: index + 1 };
    if (character === '\\') {
      const escaped = text[index + 1];
      const simpleEscapes = {
        b: '\b',
        t: '\t',
        n: '\n',
        f: '\f',
        r: '\r',
        '"': '"',
        '\\': '\\',
      };
      if (Object.hasOwn(simpleEscapes, escaped)) {
        value += simpleEscapes[escaped];
        index += 2;
        continue;
      }
      if (escaped === 'u' || escaped === 'U') {
        const length = escaped === 'u' ? 4 : 8;
        value += decodeUnicodeEscape(text.slice(index + 2, index + 2 + length), unsupported);
        index += length + 2;
        continue;
      }
      unsupported();
    }
    const codePoint = character.codePointAt(0);
    if ((codePoint <= 0x08) || (codePoint >= 0x0a && codePoint <= 0x1f) || codePoint === 0x7f) unsupported();
    value += character;
    index += 1;
  }
  unsupported();
}

function readLiteralKey(text, start, unsupported = unsupportedHeader) {
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") return { value, end: index + 1 };
    const codePoint = character.codePointAt(0);
    if ((codePoint <= 0x08) || (codePoint >= 0x0a && codePoint <= 0x1f) || codePoint === 0x7f) unsupported();
    value += character;
    index += 1;
  }
  unsupported();
}

function readKeySegment(text, start, unsupported = unsupportedHeader) {
  if (text[start] === '"') return readBasicKey(text, start, unsupported);
  if (text[start] === "'") return readLiteralKey(text, start, unsupported);
  let index = start;
  while (index < text.length && isBareKeyCharacter(text[index])) index += 1;
  if (index === start) unsupported();
  return { value: text.slice(start, index), end: index };
}

function tableHeader(line) {
  const text = line.replace(/\r?\n$/, '');
  let index = 0;
  let closed = false;
  while (isInlineWhitespace(text[index])) index += 1;
  if (text[index] !== '[') return null;

  const array = text[index + 1] === '[';
  index += array ? 2 : 1;
  const path = [];

  while (index < text.length) {
    while (isInlineWhitespace(text[index])) index += 1;
    const segment = readKeySegment(text, index);
    path.push(segment.value);
    index = segment.end;
    while (isInlineWhitespace(text[index])) index += 1;

    if (text[index] === '.') {
      index += 1;
      continue;
    }
    if (array ? text.slice(index, index + 2) === ']]' : text[index] === ']') {
      index += array ? 2 : 1;
      closed = true;
      break;
    }
    unsupportedHeader();
  }

  if (!path.length || !closed) unsupportedHeader();
  while (isInlineWhitespace(text[index])) index += 1;
  if (index < text.length && text[index] !== '#') unsupportedHeader();
  if (index >= text.length || text[index] === '#') return { array, path };
  unsupportedHeader();
}

function keyValueStatement(line) {
  const text = line.replace(/\r?\n$/, '');
  let index = 0;
  while (isInlineWhitespace(text[index])) index += 1;
  if (index >= text.length || text[index] === '#') return null;

  const path = [];
  while (index < text.length) {
    while (isInlineWhitespace(text[index])) index += 1;
    const segment = readKeySegment(text, index, unsupportedKeyValue);
    path.push(segment.value);
    index = segment.end;
    while (isInlineWhitespace(text[index])) index += 1;
    if (text[index] === '.') {
      index += 1;
      continue;
    }
    if (text[index] === '=') {
      return { path, valueStart: index + 1 };
    }
    unsupportedKeyValue();
  }
  unsupportedKeyValue();
}

function skipBasicString(text, start) {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index += 1;
  }
  throw new Error('Codex config contains an unterminated TOML basic string.');
}

function skipLiteralString(text, start) {
  const end = text.indexOf("'", start + 1);
  if (end < 0) throw new Error('Codex config contains an unterminated TOML literal string.');
  return end + 1;
}

function scanValueState(line, start, initialState, containers) {
  const text = line.replace(/\r?\n$/, '');
  let state = initialState;
  let index = start;

  while (index < text.length) {
    if (state === 'basic') {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text.slice(index, index + 3) === '"""') {
        let quoteCount = 3;
        while (text[index + quoteCount] === '"') quoteCount += 1;
        if (quoteCount > 5) throw new Error('Codex config contains a TOML multiline basic string this installer cannot safely preserve.');
        state = null;
        index += quoteCount;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === 'literal') {
      if (text.slice(index, index + 3) === "'''") {
        let quoteCount = 3;
        while (text[index + quoteCount] === "'") quoteCount += 1;
        if (quoteCount > 5) throw new Error('Codex config contains a TOML multiline literal string this installer cannot safely preserve.');
        state = null;
        index += quoteCount;
        continue;
      }
      index += 1;
      continue;
    }

    if (text[index] === '#') break;
    if (text.slice(index, index + 3) === '"""') {
      state = 'basic';
      index += 3;
      continue;
    }
    if (text.slice(index, index + 3) === "'''") {
      state = 'literal';
      index += 3;
      continue;
    }
    if (text[index] === '"') {
      index = skipBasicString(text, index);
      continue;
    }
    if (text[index] === "'") {
      index = skipLiteralString(text, index);
      continue;
    }
    if (text[index] === '[' || text[index] === '{') {
      containers.push(text[index]);
      index += 1;
      continue;
    }
    if (text[index] === ']' || text[index] === '}') {
      const expected = text[index] === ']' ? '[' : '{';
      if (containers.at(-1) !== expected) {
        throw new Error('Codex config contains an unbalanced TOML array or inline table.');
      }
      containers.pop();
      index += 1;
      continue;
    }
    index += 1;
  }

  return state;
}

function tableRanges(source) {
  const lines = source ? source.split(/(?<=\n)/) : [];
  const lineStartsInMultiline = [];
  const tables = [];
  const assignments = [];
  const containers = [];
  let currentTable = null;
  let multilineState = null;

  for (let index = 0; index < lines.length; index += 1) {
    lineStartsInMultiline[index] = multilineState !== null;
    if (multilineState === null && containers.length === 0) {
      const header = tableHeader(lines[index]);
      if (header) {
        currentTable = { ...header, start: index, end: lines.length };
        tables.push(currentTable);
        continue;
      }
      const statement = keyValueStatement(lines[index]);
      if (!statement) continue;
      assignments.push({
        path: [...(currentTable?.path || []), ...statement.path],
        tablePath: currentTable?.path || null,
        line: index,
        valueStart: statement.valueStart,
      });
      multilineState = scanValueState(lines[index], statement.valueStart, multilineState, containers);
      continue;
    }
    multilineState = scanValueState(lines[index], 0, multilineState, containers);
  }
  if (multilineState !== null) {
    throw new Error('Codex config contains an unterminated TOML multiline string.');
  }
  if (containers.length) {
    throw new Error('Codex config contains an unterminated TOML array or inline table.');
  }
  for (let index = 0; index < tables.length - 1; index += 1) tables[index].end = tables[index + 1].start;
  return { source, lines, lineStartsInMultiline, tables, assignments };
}

function targetTableName(serverName) {
  return `mcp_servers.${serverName}`;
}

function pathsEqual(left, right) {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function pathStartsWith(path, prefix) {
  return path.length >= prefix.length && prefix.every((segment, index) => path[index] === segment);
}

function serverTableSet(document, serverName) {
  const prefix = ['mcp_servers', serverName];
  const conflictingAssignment = document.assignments.find(assignment => {
    if (assignment.tablePath && pathStartsWith(assignment.tablePath, prefix)) return false;
    return pathStartsWith(assignment.path, prefix) || pathStartsWith(prefix, assignment.path);
  });
  if (conflictingAssignment) {
    throw new Error(`Codex config defines ${targetTableName(serverName)} through dotted keys or inline values; refusing to modify it.`);
  }
  const exact = document.tables.filter(table => pathsEqual(table.path, prefix));
  if (exact.some(table => table.array)) {
    throw new Error(`Codex config uses an unsupported array table for ${targetTableName(serverName)}.`);
  }
  if (exact.length > 1) {
    throw new Error(`Codex config contains duplicate ${targetTableName(serverName)} tables.`);
  }
  const descendants = document.tables.filter(table => table.path.length > prefix.length && pathStartsWith(table.path, prefix));
  if (!exact.length && descendants.length) {
    throw new Error(`Codex config contains descendant tables for ${targetTableName(serverName)} without an exact server table.`);
  }
  return { exact: exact[0], descendants };
}

function decodeTomlString(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Codex MCP URL must be a valid TOML basic string.');
  }
}

const ENDPOINT_KEYS = new Set(['url', 'httpUrl', 'serverUrl', 'command', 'args']);

function endpointDefinitions(document, range) {
  const prefixLength = range.path.length;
  const assignments = document.assignments.filter(assignment => (
    assignment.tablePath
    && pathsEqual(assignment.tablePath, range.path)
    && ENDPOINT_KEYS.has(assignment.path[prefixLength])
  ));
  const tables = document.tables.filter(table => (
    table.path.length > prefixLength
    && pathStartsWith(table.path, range.path)
    && ENDPOINT_KEYS.has(table.path[prefixLength])
  ));
  return { assignments, tables };
}

function basicStringAssignment(document, assignment) {
  const line = document.lines[assignment.line].replace(/\r?\n$/, '');
  let index = assignment.valueStart;
  while (isInlineWhitespace(line[index])) index += 1;
  if (line.slice(index, index + 3) === '"""' || line[index] !== '"') return undefined;
  let end = skipBasicString(line, index);
  const raw = line.slice(index, end);
  while (isInlineWhitespace(line[end])) end += 1;
  if (end < line.length && line[end] !== '#') return undefined;
  return decodeTomlString(raw);
}

function readUrl(document, range) {
  const endpoints = endpointDefinitions(document, range);
  if (endpoints.tables.length || endpoints.assignments.length !== 1) return undefined;
  const assignment = endpoints.assignments[0];
  if (
    assignment.path.length !== range.path.length + 1
    || assignment.path.at(-1) !== 'url'
  ) {
    return undefined;
  }
  return basicStringAssignment(document, assignment);
}

function readString(document, range, key) {
  let result;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?(?:\\r?\\n)?$`);
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (document.lineStartsInMultiline[index]) continue;
    const match = document.lines[index].match(pattern);
    if (!match) continue;
    if (result !== undefined) throw new Error(`Codex MCP table contains duplicate ${key} keys.`);
    result = decodeTomlString(match[1]);
  }
  return result;
}

function readStringArray(document, range, key) {
  let result;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(\\[.*])\\s*(?:#.*)?(?:\\r?\\n)?$`);
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (document.lineStartsInMultiline[index]) continue;
    const match = document.lines[index].match(pattern);
    if (!match) continue;
    if (result !== undefined) throw new Error(`Codex MCP table contains duplicate ${key} keys.`);
    try {
      const parsed = JSON.parse(match[1]);
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error();
      result = parsed;
    } catch {
      throw new Error(`Codex MCP ${key} must be a simple array of strings.`);
    }
  }
  return result;
}

function removeTables(document, tables) {
  if (!tables.length) return document.source;
  const removedLineIndexes = new Set();
  for (const table of tables) {
    let end = table.end;
    let blankRunStart;
    for (let index = table.start + 1; index < table.end; index += 1) {
      const trimmed = document.lines[index].trim();
      if (!trimmed) {
        blankRunStart ??= index;
      } else if (trimmed.startsWith('#')) {
        if (blankRunStart !== undefined) {
          end = blankRunStart;
          break;
        }
      } else {
        blankRunStart = undefined;
      }
    }
    for (let index = table.start; index < end; index += 1) removedLineIndexes.add(index);
  }
  return document.lines.filter((_, index) => !removedLineIndexes.has(index)).join('');
}

function preferredNewline(source) {
  return source.match(/\r\n|\n/)?.[0] || '\n';
}

function endsWithNewline(source) {
  return source.endsWith('\r\n') || source.endsWith('\n');
}

function endsWithBlankLine(source) {
  const withoutLastNewline = source.replace(/(?:\r\n|\n)$/, '');
  return endsWithNewline(source) && endsWithNewline(withoutLastNewline);
}

function appendRemoteTable(source, target, mcpUrl) {
  const newline = preferredNewline(source);
  const separator = !source || endsWithBlankLine(source)
    ? ''
    : endsWithNewline(source) ? newline : `${newline}${newline}`;
  return `${source}${separator}[${target}]${newline}url = ${JSON.stringify(mcpUrl)}${newline}`;
}

function appendProxyTable(source, target, command, args) {
  const newline = preferredNewline(source);
  const separator = !source || endsWithBlankLine(source)
    ? ''
    : endsWithNewline(source) ? newline : `${newline}${newline}`;
  return `${source}${separator}[${target}]${newline}command = ${JSON.stringify(command)}${newline}args = ${JSON.stringify(args)}${newline}`;
}

function duplicateReconciliation(document, serverName, mcpUrl, duplicateServerNames) {
  const names = [...new Set(duplicateServerNames.filter(name => name !== serverName))];
  const removedDuplicates = [];
  const removedTables = [];

  for (const name of names) {
    const tableSet = legacyServerTableSet(document, name);
    if (!tableSet || !isExactOwnedLegacyTable(document, tableSet, mcpUrl)) continue;
    removedDuplicates.push({ name });
    removedTables.push(tableSet.exact);
  }

  return {
    removedDuplicates,
    source: removeTables(document, removedTables),
  };
}

function legacyServerTableSet(document, serverName) {
  const prefix = ['mcp_servers', serverName];
  const conflictingAssignment = document.assignments.some(assignment => {
    if (assignment.tablePath && pathStartsWith(assignment.tablePath, prefix)) return false;
    return pathStartsWith(assignment.path, prefix) || pathStartsWith(prefix, assignment.path);
  });
  if (conflictingAssignment) return null;
  const exact = document.tables.filter(table => pathsEqual(table.path, prefix));
  if (exact.length !== 1 || exact[0].array) return null;
  const descendants = document.tables.filter(table => table.path.length > prefix.length && pathStartsWith(table.path, prefix));
  return { exact: exact[0], descendants };
}

function isExactOwnedLegacyTable(document, tableSet, mcpUrl) {
  if (tableSet.descendants.length) return false;
  const assignments = document.assignments.filter(assignment => (
    assignment.tablePath && pathsEqual(assignment.tablePath, tableSet.exact.path)
  ));
  if (assignments.length !== 1) return false;
  const assignment = assignments[0];
  if (
    assignment.path.length !== tableSet.exact.path.length + 1
    || assignment.path.at(-1) !== 'url'
  ) {
    return false;
  }
  try {
    return basicStringAssignment(document, assignment) === mcpUrl;
  } catch {
    return false;
  }
}

export function planCodexTomlInstall(filePath, serverName, mcpUrl, dryRun = false, duplicateServerNames = [], safetyRoot) {
  const pathState = assertSafePath(filePath, safetyRoot, 'Codex config path');
  const existed = fs.existsSync(filePath);
  const source = existed ? fs.readFileSync(filePath, 'utf8') : '';
  assertSafePath(filePath, safetyRoot, 'Codex config path', pathState);
  const document = tableRanges(source);
  const target = targetTableName(serverName);
  const targetTable = serverTableSet(document, serverName).exact;
  if (targetTable) {
    const existingUrl = readUrl(document, targetTable);
    if (!existingUrl) throw new Error(`Existing Codex table ${target} has no simple url value; refusing to replace it.`);
    if (existingUrl !== mcpUrl) throw new Error(`Refusing to replace existing Codex MCP server "${serverName}" with a different URL.`);
  }

  const reconciliation = duplicateReconciliation(document, serverName, mcpUrl, duplicateServerNames);
  if (targetTable) {
    return {
      client: 'codex',
      path: filePath,
      format: 'toml',
      content: reconciliation.source,
      originalContent: source,
      action: reconciliation.removedDuplicates.length ? 'update' : 'unchanged',
      existed,
      dryRun,
      removedDuplicates: reconciliation.removedDuplicates,
      canonicalRegistrationChanged: false,
      canonicalRegistrationPresent: true,
      safetyRoot,
      pathLabel: 'Codex config path',
      pathState,
    };
  }

  return {
    client: 'codex',
    path: filePath,
    format: 'toml',
    content: appendRemoteTable(reconciliation.source, target, mcpUrl),
    originalContent: existed ? source : undefined,
    action: existed ? 'update' : 'create',
    existed,
    dryRun,
    removedDuplicates: reconciliation.removedDuplicates,
    canonicalRegistrationChanged: true,
    canonicalRegistrationPresent: true,
    safetyRoot,
    pathLabel: 'Codex config path',
    pathState,
  };
}

export function planCodexTomlProxyInstall(filePath, serverName, command, args, dryRun = false, safetyRoot) {
  const pathState = assertSafePath(filePath, safetyRoot, 'Codex config path');
  const existed = fs.existsSync(filePath);
  const source = existed ? fs.readFileSync(filePath, 'utf8') : '';
  assertSafePath(filePath, safetyRoot, 'Codex config path', pathState);
  const document = tableRanges(source);
  const target = targetTableName(serverName);
  const targetTable = serverTableSet(document, serverName).exact;
  if (targetTable) {
    const existingCommand = readString(document, targetTable, 'command');
    const existingArgs = readStringArray(document, targetTable, 'args');
    if (!existingCommand || !existingArgs) throw new Error(`Existing Codex table ${target} is not a simple stdio proxy configuration; refusing to replace it.`);
    if (existingCommand !== command || JSON.stringify(existingArgs) !== JSON.stringify(args)) {
      throw new Error(`Refusing to replace existing Codex MCP server "${serverName}" with a different proxy command.`);
    }
    return {
      client: 'codex',
      path: filePath,
      format: 'toml',
      content: source,
      originalContent: source,
      action: 'unchanged',
      existed,
      dryRun,
      safetyRoot,
      pathLabel: 'Codex config path',
      pathState,
    };
  }

  return {
    client: 'codex',
    path: filePath,
    format: 'toml',
    content: appendProxyTable(source, target, command, args),
    originalContent: existed ? source : undefined,
    action: existed ? 'update' : 'create',
    existed,
    dryRun,
    safetyRoot,
    pathLabel: 'Codex config path',
    pathState,
  };
}

export function inspectCodexToml(filePath, serverName, mcpUrl, duplicateServerNames = [], safetyRoot) {
  assertSafePath(filePath, safetyRoot, 'Codex config path');
  if (!fs.existsSync(filePath)) return { exists: false, installed: false, mismatch: false };
  const source = fs.readFileSync(filePath, 'utf8');
  const document = tableRanges(source);
  const targetTable = serverTableSet(document, serverName).exact;
  const url = targetTable ? readUrl(document, targetTable) : undefined;
  const reconciliation = duplicateReconciliation(document, serverName, mcpUrl, duplicateServerNames);
  return {
    exists: true,
    installed: url === mcpUrl,
    mismatch: Boolean(url && url !== mcpUrl),
    duplicates: reconciliation.removedDuplicates,
  };
}

export function assertExactCodexRemoteRegistration(filePath, serverName, mcpUrl, safetyRoot) {
  try {
    const pathState = assertSafePath(filePath, safetyRoot, 'Codex config path');
    if (!fs.existsSync(filePath)) throw new Error('missing');
    const source = fs.readFileSync(filePath, 'utf8');
    assertSafePath(filePath, safetyRoot, 'Codex config path', pathState);
    const document = tableRanges(source);
    const tableSet = serverTableSet(document, serverName);
    if (!tableSet.exact) throw new Error('unsupported');
    if (readUrl(document, tableSet.exact) !== mcpUrl) throw new Error('mismatch');
    assertSafePath(filePath, safetyRoot, 'Codex config path', pathState);
    return true;
  } catch {
    const error = new Error('Codex MCP registration changed before authentication; refusing to start native login.');
    error.configurationValidation = true;
    throw error;
  }
}

export function planCodexTomlUninstall(filePath, serverName, mcpUrl, dryRun = false, duplicateServerNames = [], safetyRoot) {
  const pathState = assertSafePath(filePath, safetyRoot, 'Codex config path');
  if (!fs.existsSync(filePath)) return null;
  const source = fs.readFileSync(filePath, 'utf8');
  assertSafePath(filePath, safetyRoot, 'Codex config path', pathState);
  const document = tableRanges(source);
  const tableSet = serverTableSet(document, serverName);
  const removedTables = [];
  const removedEntries = [];
  if (tableSet.exact) {
    const existingUrl = readUrl(document, tableSet.exact);
    if (!existingUrl || existingUrl !== mcpUrl) {
      throw new Error(`Refusing to remove Codex MCP server "${serverName}" because its URL does not match.`);
    }
    removedTables.push(tableSet.exact, ...tableSet.descendants);
    removedEntries.push({ name: serverName });
  }
  const reconciliation = duplicateReconciliation(document, serverName, mcpUrl, duplicateServerNames);
  for (const duplicate of reconciliation.removedDuplicates) {
    const duplicateSet = legacyServerTableSet(document, duplicate.name);
    if (!duplicateSet) continue;
    removedTables.push(duplicateSet.exact);
    removedEntries.push(duplicate);
  }
  if (!removedEntries.length) return null;
  return {
    client: 'codex',
    path: filePath,
    format: 'toml',
    content: removeTables(document, removedTables),
    originalContent: source,
    action: 'uninstall',
    existed: true,
    dryRun,
    removedEntries,
    safetyRoot,
    pathLabel: 'Codex config path',
    pathState,
  };
}
