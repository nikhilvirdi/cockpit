import { Parser, Language as Grammar } from '@vscode/tree-sitter-wasm';
import type { Node, Tree } from '@vscode/tree-sitter-wasm';
import type { CallableNode, IndexedLanguage, SourceRange } from './types';

export type Span = { start: number; end: number };
export type SyntaxCallable = { name: string; qualifiedName: string; kind: CallableNode['kind']; at: Span; token?: Span; signature?: Span; dispatch: boolean; owner?: Span };
export type SyntaxCall = { at: Span; token?: Span; scope?: SyntaxCallable; kind: 'call' | 'construct' };
export type SyntaxImport = { at: Span; token?: Span; kind: 'import' | 'include' };
export type SyntaxFile = { callables: SyntaxCallable[]; calls: SyntaxCall[]; imports: SyntaxImport[]; hasErrors: boolean };

const grammars = new Map<string, Promise<Grammar>>();
let runtime: Promise<void> | undefined;

export async function openParser(language: IndexedLanguage) {
  runtime ??= Parser.init();
  await runtime;
  const grammar = language;
  let loaded = grammars.get(grammar);
  if (!loaded) {
    loaded = Grammar.load(grammar === 'c' ? require.resolve('tree-sitter-c/tree-sitter-c.wasm')
      : require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-' + grammar + '.wasm'));
    grammars.set(grammar, loaded);
  }
  const parser = new Parser();
  parser.setLanguage(await loaded);
  return parser;
}

function span(node: Node): Span {
  return { start: node.startIndex, end: node.endIndex };
}

export function contains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && outer.end >= inner.end && inner.start < inner.end;
}

function memberToken(node: Node | null): Node | null {
  while (node) {
    switch (node.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
        return node;
      case 'attribute': node = node.childForFieldName('attribute'); break;
      case 'selector_expression': node = node.childForFieldName('field'); break;
      case 'field_expression': node = node.childForFieldName('field'); break;
      case 'qualified_identifier':
      case 'template_function':
      case 'template_method': node = node.childForFieldName('name'); break;
      case 'destructor_name': return node;
      case 'parenthesized_expression': node = node.namedChild(0); break;
      case 'index_expression': node = node.childForFieldName('operand'); break;
      default: return null;
    }
  }
  return null;
}

function functionName(node: Node): Node | null {
  let declarator = node.childForFieldName('declarator');
  while (declarator) {
    if (declarator.type === 'function_declarator') {
      const name = declarator.childForFieldName('declarator');
      return memberToken(name);
    }
    declarator = declarator.childForFieldName('declarator');
  }
  return null;
}

export function readSyntax(tree: Tree, language: IndexedLanguage): SyntaxFile {
  const result: SyntaxFile = { callables: [], calls: [], imports: [], hasErrors: tree.rootNode.hasError };
  const stack: Array<{ node: Node; names: string[]; scope?: SyntaxCallable; owner?: Span }> = [{ node: tree.rootNode, names: [] }];
  while (stack.length) {
    const { node, names, scope, owner } = stack.pop()!;
    let childNames = names;
    let childScope = scope;
    const native = language === 'c' || language === 'cpp';
    const name = node.childForFieldName('name');
    const isType = /^(class_definition|class_declaration|interface_declaration|class_specifier|struct_specifier|namespace_definition)$/.test(node.type);
    if (name && isType) childNames = [...names, name.text];

    let token: Node | null = null;
    let parameters = node.childForFieldName('parameters');
    let kind: CallableNode['kind'] = 'function';
    let dispatch = false;
    if (language === 'python' && node.type === 'function_definition') {
      token = name;
      const inClass = node.parent?.parent?.type === 'class_definition'
        || node.parent?.type === 'decorated_definition' && node.parent.parent?.parent?.type === 'class_definition';
      const decorators = node.parent?.type === 'decorated_definition'
        ? node.parent.namedChildren.filter(child => child?.type === 'decorator') : [];
      const staticMethod = decorators.length === 1 && decorators[0]?.text === '@staticmethod';
      kind = inClass ? token?.text === '__init__' ? 'constructor' : staticMethod ? 'static-method' : 'method' : 'function';
      dispatch = decorators.length > 0 && !staticMethod || inClass && !staticMethod && kind !== 'constructor';
    } else if (language === 'go' && (node.type === 'function_declaration' || node.type === 'method_declaration')) {
      token = name;
      if (node.type === 'method_declaration') {
        kind = 'method';
        const receiver = node.childForFieldName('receiver')?.namedChild(0)?.childForFieldName('type');
        if (receiver) childNames = [...names, receiver.text.replace(/^\*/, '')];
      }
    } else if (language === 'java' && /^(method_declaration|constructor_declaration)$/.test(node.type)
      && node.childForFieldName('body')) {
      token = name;
      const modifiers = node.namedChildren.find(child => child?.type === 'modifiers');
      const isStatic = modifiers?.children.some(child => child?.type === 'static');
      kind = node.type === 'constructor_declaration' ? 'constructor' : isStatic ? 'static-method' : 'method';
      const ownerModifiers = node.parent?.parent?.namedChildren.find(child => child?.type === 'modifiers');
      dispatch = kind === 'method' && !modifiers?.children.some(child => child?.type === 'final' || child?.type === 'private')
        && !ownerModifiers?.children.some(child => child?.type === 'final');
    } else if (native && node.type === 'function_definition') {
      token = functionName(node);
      const owner = node.parent?.parent;
      kind = owner && /^(class_specifier|struct_specifier)$/.test(owner.type) ? 'method' : 'function';
      const functionDeclarator = node.childForFieldName('declarator');
      const declarator = functionDeclarator?.childForFieldName('declarator');
      parameters = functionDeclarator?.childForFieldName('parameters') ?? null;
      if (language === 'cpp' && declarator?.type === 'qualified_identifier') {
        kind = 'method';
        const qualifier = declarator.childForFieldName('scope');
        if (qualifier) childNames = [...names, qualifier.text];
      }
      if (kind === 'method' && token?.text === childNames.at(-1)) kind = 'constructor';
      // A definition alone cannot exclude inherited virtual dispatch on an out-of-line method.
      const finalClass = owner?.namedChildren.some(child => child?.type === 'virtual_specifier' && child.text === 'final');
      const unboundOwner = !!declarator && declarator.type === 'qualified_identifier';
      const virtualMethod = node.children.some(child => child?.type === 'virtual')
        || functionDeclarator?.namedChildren.some(child => child?.type === 'virtual_specifier' && child.text === 'override');
      const inheritedMethod = owner?.namedChildren.some(child => child?.type === 'base_class_clause');
      const finalMethod = functionDeclarator?.namedChildren.some(child => child?.type === 'virtual_specifier' && child.text === 'final');
      dispatch = language === 'cpp' && kind === 'method' && !finalClass && !finalMethod
        && !!(unboundOwner || virtualMethod || inheritedMethod);
    }

    const anonymous = ['lambda', 'lambda_expression', 'func_literal'].includes(node.type);
    if ((anonymous || token && !token.hasError) && !node.hasError) {
      const label = token?.text ?? (node.type === 'func_literal' ? '<anonymous>' : '<lambda>');
      childScope = { name: label, qualifiedName: [...childNames, label].join('.'), kind: anonymous ? 'arrow' : kind,
        at: span(node), token: token ? span(token) : undefined, signature: parameters ? span(parameters) : undefined,
        dispatch, owner: kind === 'constructor' ? owner : undefined };
      result.callables.push(childScope);
      childNames = [...childNames, label];
    }

    if (language === 'python' && node.type === 'call' || (language === 'go' || native) && node.type === 'call_expression'
      || language === 'java' && /^(method_invocation|object_creation_expression|explicit_constructor_invocation)$/.test(node.type)
      || language === 'cpp' && node.type === 'new_expression') {
      const construction = /^(object_creation_expression|explicit_constructor_invocation|new_expression)$/.test(node.type);
      const callee = node.type === 'explicit_constructor_invocation' ? node.childForFieldName('constructor')
        : memberToken(node.childForFieldName(construction ? 'type' : language === 'java' ? 'name' : 'function'));
      if (!node.hasError) result.calls.push({ at: span(node), token: callee ? span(callee) : undefined,
        scope, kind: construction ? 'construct' : 'call' });
    }

    if (language === 'python' && /^(import_statement|import_from_statement|future_import_statement)$/.test(node.type)
      || language === 'go' && node.type === 'import_spec' || language === 'java' && node.type === 'import_declaration'
      || native && node.type === 'preproc_include') {
      const target = node.childForFieldName('path');
      if (!node.hasError) result.imports.push({ at: span(node), token: target ? span(target) : undefined, kind: native ? 'include' : 'import' });
    }
    const body = childScope !== scope ? node.childForFieldName('body') : null;
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push({ node: child, names: childNames,
        scope: body && child.id !== body.id ? scope : childScope,
        owner: name && isType ? span(name) : owner });
    }
  }
  return result;
}

export function sourcePositions(file: string, source: string) {
  const lines = source.split('\n');
  const starts = [0];
  for (let i = 0; i + 1 < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
  const columns = new Map<number, Int32Array | undefined>();
  function offset(line: number, column: number, encoding: number) {
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || line >= lines.length || column < 0) return;
    const text = lines[line];
    const length = text.endsWith('\r') ? text.length - 1 : text.length;
    if (encoding === 2) {
      if (column <= length && !(column > 0 && /[\uDC00-\uDFFF]/.test(text[column] ?? ''))) return starts[line] + column;
      return;
    }
    const key = line * 4 + encoding;
    if (!columns.has(key)) {
      const content = text.slice(0, length);
      let table: Int32Array | undefined;
      // ASCII needs no mapping. Index multibyte lines once even if this file has many occurrences.
      if (/[^\x00-\x7F]/.test(content)) {
        table = new Int32Array((encoding === 1 ? Buffer.byteLength(content) : length) + 1).fill(-1);
        let units = 0;
        let utf16 = 0;
        for (const point of content) {
          table[units] = utf16;
          units += encoding === 1 ? Buffer.byteLength(point) : 1;
          utf16 += point.length;
        }
        table[units] = utf16;
      }
      columns.set(key, table);
    }
    const table = columns.get(key);
    const position = table ? table[column] : column <= length ? column : undefined;
    if (position !== undefined && position >= 0) return starts[line] + position;
  }
  function point(offset: number) {
    let low = 0, high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return [low, offset - starts[low]];
  }
  function range(at: Span): SourceRange {
    const [startLine, startColumn] = point(at.start);
    const [endLine, endColumn] = point(at.end);
    return { file, startLine, startColumn, endLine, endColumn };
  }
  return { offset, range, clearOffsets: () => columns.clear() };
}

