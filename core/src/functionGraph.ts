import * as path from 'path';
import { Project, ts } from 'ts-morph';
import type { CallEvidence, CallableNode, FunctionCallEdge, FunctionGraph, GraphNode, SourceRange } from './types';
import { toPosixPath } from './scanner';

type Call = ts.CallExpression | ts.NewExpression;
type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
  | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration;

type Target =
  | { status: 'resolved'; node: CallableNode }
  | { status: 'external' }
  | { status: 'unresolved' | 'ambiguous'; reason: string; candidates?: string[] };

function isCompilerRecursion(error: unknown): boolean {
  return error instanceof RangeError && error.message === 'Maximum call stack size exceeded';
}

function isCallable(node: ts.Node): node is Callable {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isExpressionWithTypeArguments(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function ownerName(node: ts.Node): ts.DeclarationName | ts.Expression | undefined {
  let owner = node.parent;
  while (ts.isExpression(owner) && unwrap(owner) === node) owner = owner.parent;
  if ((ts.isVariableDeclaration(owner) || ts.isPropertyDeclaration(owner) || ts.isPropertyAssignment(owner))
    && owner.initializer && unwrap(owner.initializer) === node) return owner.name;
  if (ts.isBinaryExpression(owner) && owner.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && unwrap(owner.right) === node && ts.isPropertyAccessExpression(owner.left)) return owner.left.name;
  return undefined;
}

function callableKind(node: Callable): CallableNode['kind'] {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isArrowFunction(node)) return 'arrow';
  if (ts.isGetAccessorDeclaration(node)) return 'getter';
  if (ts.isSetAccessorDeclaration(node)) return 'setter';
  if (ts.isMethodDeclaration(node)) {
    return ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static ? 'static-method' : 'method';
  }
  return 'function';
}

function canConstruct(node: ts.Node): boolean {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
    && !node.asteriskToken && !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async);
}

function sourceRange(file: string, source: ts.SourceFile, start: number, end: number): SourceRange {
  const first = source.getLineAndCharacterOfPosition(start);
  const last = source.getLineAndCharacterOfPosition(end);
  return { file, startLine: first.line, startColumn: first.character, endLine: last.line, endColumn: last.character };
}

function atNode(file: string, node: ts.Node): SourceRange {
  const source = node.getSourceFile();
  return sourceRange(file, source, node.getStart(source), node.getEnd());
}

function immutableVariable(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const);
}

function initializerOf(declaration: ts.Declaration | undefined): ts.Expression | undefined {
  if (!declaration) return undefined;
  if (ts.isExportAssignment(declaration)) return declaration.expression;
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)
    || ts.isPropertyAssignment(declaration)) return declaration.initializer;
  if (ts.isPropertyAccessExpression(declaration) && ts.isBinaryExpression(declaration.parent)
    && declaration.parent.left === declaration && declaration.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return declaration.parent.right;
  }
  return undefined;
}

function isTypeOnlyAlias(node: ts.Declaration): boolean {
  if (ts.isImportClause(node) || ts.isImportEqualsDeclaration(node)) return node.isTypeOnly;
  if (ts.isImportSpecifier(node)) return node.isTypeOnly || node.parent.parent.isTypeOnly;
  if (ts.isNamespaceImport(node)) return node.parent.isTypeOnly;
  if (ts.isExportSpecifier(node)) return node.isTypeOnly || node.parent.parent.isTypeOnly;
  if (ts.isNamespaceExport(node)) return node.parent.isTypeOnly;
  return false;
}

function unresolved(reason: string): { status: 'unresolved'; reason: string } {
  return { status: 'unresolved', reason };
}

export function buildFunctionGraph(
  project: Project,
  graphNodes: GraphNode[],
  rootDir: string,
  configDiagnostics: Iterable<ts.Diagnostic>
): FunctionGraph {
  const program = project.getProgram().compilerObject;
  const checker = project.getTypeChecker().compilerObject;
  const files = new Map<ts.SourceFile, string>();
  for (const node of [...graphNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const source = project.getSourceFile(node.path)?.compilerNode;
    if (source) files.set(source, node.id);
  }

  const nodes = new Map<ts.Node, CallableNode>();
  const calls: Array<{ node: Call; file: string; caller?: string; initializer: boolean }> = [];
  const writeSites: Array<{ target: ts.Node; assigned?: ts.Expression }> = [];
  const writes = new Set<ts.Symbol>();
  const dynamicWrites = new Set<ts.Symbol>();
  const edges = new Map<string, FunctionCallEdge>();
  const moduleCalls: FunctionGraph['moduleCalls'] = [];
  const unresolvedCalls: FunctionGraph['unresolved'] = [];
  const diagnostics: FunctionGraph['diagnostics'] = [];
  const diagnosticKeys = new Set<string>();
  const errorsByFile = new Map<ts.SourceFile, ts.DiagnosticWithLocation[]>();
  const failedFiles = new Set<ts.SourceFile>();
  const constructorsReplacingThis = new Set<ts.ClassLikeDeclaration>();
  const constructionChecks = new Map<ts.ClassLikeDeclaration, boolean>();
  const exportsByModule = new Map<ts.Symbol, Map<string, ts.Symbol>>();

  function report(diagnostic: ts.Diagnostic) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) return;
    const { file, start, length, code } = diagnostic;
    const relative = file && path.relative(rootDir, file.fileName);
    const localFile = relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      ? toPosixPath(relative) : undefined;
    const id = file && (files.get(file) ?? localFile);
    const at = id && start !== undefined
      ? sourceRange(id, file, start, start + (length ?? 0)) : undefined;
    // Message templates preserve the diagnostic category without quoting host paths or source text.
    const template = diagnosticMessages.get(code);
    const reason = template ?? 'TypeScript reported an analysis error';
    const key = JSON.stringify([code, at, reason]);
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push({ code, reason, ...(at && { at }) });
  }

  function canonical(symbol: ts.Symbol): ts.Symbol {
    return checker.getExportSymbolOfSymbol(symbol);
  }

  function symbolAt(expression: ts.Expression): ts.Symbol | undefined {
    if (ts.isPropertyAccessExpression(expression)) return checker.getSymbolAtLocation(expression.name);
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
      return checker.getSymbolAtLocation(expression.argumentExpression)
        ?? checker.getPropertyOfType(checker.getTypeAtLocation(expression.expression), expression.argumentExpression.text);
    }
    return checker.getSymbolAtLocation(expression);
  }

  function decorated(node: ts.Node): boolean {
    return ts.canHaveDecorators(node) && !!ts.getDecorators(node)?.length;
  }

  function exportedMember(module: ts.Symbol, name: string): ts.Symbol | undefined {
    let exports = exportsByModule.get(module);
    if (!exports) {
      exports = new Map(checker.getExportsOfModule(module).map(symbol => [symbol.name, symbol]));
      exportsByModule.set(module, exports);
    }
    return exports.get(name);
  }

  function recordWrite(target: ts.Node, assigned?: ts.Expression) {
    if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
      const members = ts.isObjectLiteralExpression(target) ? target.properties : target.elements;
      for (const member of members) recordWrite(member);
      return;
    }
    if (ts.isPropertyAssignment(target)) return recordWrite(target.initializer);
    if (ts.isSpreadAssignment(target) || ts.isSpreadElement(target)) return recordWrite(target.expression);
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) return recordWrite(target.left);
    if (ts.isParenthesizedExpression(target)) return recordWrite(target.expression);
    if (ts.isElementAccessExpression(target) && propertyKey(target) === undefined) {
      // Use the written receiver's type even when another write has already invalidated its origin.
      const receiver = target.expression;
      const symbol = receiver && checker.getTypeAtLocation(receiver).symbol;
      if (symbol) dynamicWrites.add(canonical(symbol));
      return;
    }
    const symbol = ts.isShorthandPropertyAssignment(target)
      ? checker.getShorthandAssignmentValueSymbol(target)
      : ts.isExpression(target) ? symbolAt(target) : undefined;
    if (symbol) {
      // TypeScript models a single CommonJS assignment as the declaration of an export.
      if (assigned && symbol.declarations?.length === 1 && symbol.declarations[0] === target
        && /\.(?:[cm]?js|jsx)$/i.test(target.getSourceFile().fileName)) return;
      writes.add(canonical(symbol));
      const aliased = resolveAlias(symbol);
      if (aliased) writes.add(aliased);
    }
  }

  function discover(source: ts.SourceFile, file: string) {
    const language = /\.(?:[cm]?js|jsx)$/i.test(file) ? 'javascript' : 'typescript';

    function visit(node: ts.Node, scope: string, caller?: string, initializer = false, inConstructor?: ts.ClassLikeDeclaration) {
      if (inConstructor && ts.isReturnStatement(node) && node.expression
        && unwrap(node.expression).kind !== ts.SyntaxKind.ThisKeyword) {
        constructorsReplacingThis.add(inConstructor);
      }
      if (isCallable(node) && node.body) {
        const declaration = atNode(file, node);
        const kind = callableKind(node);
        const label = ts.isConstructorDeclaration(node) ? undefined : node.name;
        const effectiveName = label ?? ownerName(node);
        const name = kind === 'constructor' ? 'constructor' : effectiveName
          ? (ts.isStringLiteralLike(effectiveName) ? effectiveName.text : effectiveName.getText(source))
          : '<anonymous@' + declaration.startLine + ':' + declaration.startColumn + '>';
        const qualifiedName = scope ? scope + '.' + name : name;
        const id = JSON.stringify([file, declaration.startLine, declaration.startColumn, kind]);
        nodes.set(node, { id, name, qualifiedName, kind, language, file, declaration });
        // Computed declaration names and decorators execute outside the callable body.
        ts.forEachChild(node, child => {
          if (child === node.body || ts.isParameter(child)) {
            visit(child, qualifiedName, id, false, ts.isConstructorDeclaration(node) ? node.parent : undefined);
          } else visit(child, scope, caller, initializer, inConstructor);
        });
        return;
      }

      if (ts.isClassLike(node) || ts.isObjectLiteralExpression(node) || ts.isModuleDeclaration(node)) {
        const name = ts.isClassLike(node) || ts.isModuleDeclaration(node) ? node.name ?? ownerName(node) : ownerName(node);
        if (name) {
          const text = name.getText(source);
          scope = scope ? scope + '.' + text : text;
        }
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push({ node, file, caller, initializer });
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        writeSites.push({ target: node.left, assigned: node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined });
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        writeSites.push({ target: node.operand });
      }
      if (ts.isDeleteExpression(node)) writeSites.push({ target: node.expression });
      if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
        writeSites.push({ target: node.initializer });
      }

      ts.forEachChild(node, child => {
        if (ts.isPropertyDeclaration(node) && child === node.initializer
          && !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static)) {
          visit(child, scope, undefined, true);
        } else {
          visit(child, scope, caller, initializer, inConstructor);
        }
      });
    }
    visit(source, '');
  }

  for (const diagnostic of configDiagnostics) report(diagnostic);
  for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) report(diagnostic);
  for (const node of graphNodes) {
    if (!project.getSourceFile(node.path)) {
      diagnostics.push({ code: 0, reason: 'Source file could not be loaded',
        at: { file: node.id, startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 } });
    }
  }
  for (const [source, file] of files) {
    discover(source, file);
    try {
      const syntaxErrors = program.getSyntacticDiagnostics(source);
      const errors = program.getSemanticDiagnostics(source)
        .filter((diagnostic): diagnostic is ts.DiagnosticWithLocation =>
          diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file === source && diagnostic.start !== undefined);
      errorsByFile.set(source, [...syntaxErrors, ...errors.filter(error => invalidCallCodes.has(error.code))]
        .sort((a, b) => a.start - b.start));
      for (const diagnostic of [...syntaxErrors, ...errors]) report(diagnostic);
    } catch (error) {
      if (!isCompilerRecursion(error)) throw error;
      failedFiles.add(source);
      diagnostics.push({ code: 0, reason: 'TypeScript exceeded its recursion limit while checking this file',
        at: atNode(file, source) });
    }
  }

  function external(declaration: ts.Declaration): boolean {
    const source = declaration.getSourceFile();
    return program.isSourceFileDefaultLibrary(source) || program.isSourceFileFromExternalLibrary(source);
  }

  function resolveAlias(symbol: ts.Symbol): ts.Symbol | undefined {
    const seen = new Set<ts.Symbol>();
    while (symbol.flags & ts.SymbolFlags.Alias) {
      if (seen.has(symbol) || symbol.declarations?.some(isTypeOnlyAlias)) return undefined;
      seen.add(symbol);
      const next = checker.getImmediateAliasedSymbol(symbol);
      if (!next) return undefined;
      symbol = next;
    }
    return canonical(symbol);
  }

  function propertyKey(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    const index = unwrap(expression.argumentExpression);
    if (ts.isStringLiteralLike(index) || ts.isNumericLiteral(index)) return index.text;
    return undefined;
  }

  function isRequire(expression: ts.Expression): expression is ts.CallExpression {
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'require') return false;
    const declarations = checker.getSymbolAtLocation(expression.expression)?.declarations;
    return !declarations?.some(declaration => files.has(declaration.getSourceFile()));
  }

  function receiverOrigin(expression: ts.Expression): ts.Expression | undefined {
    const seen = new Set<ts.Symbol>();
    for (;;) {
      expression = unwrap(expression);
      if (!ts.isIdentifier(expression)) return expression;
      const raw = symbolAt(expression);
      const local = raw?.declarations?.find(ts.isVariableDeclaration);
      const symbol = local ? raw : raw && resolveAlias(raw);
      if (!symbol || seen.has(symbol) || writes.has(symbol)) return undefined;
      const declaration = local ?? symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration)) return expression;
      if (!immutableVariable(declaration) || !declaration.initializer) return undefined;
      seen.add(symbol);
      expression = declaration.initializer;
    }
  }

  function classTarget(expression: ts.Expression): ts.ClassLikeDeclaration | undefined {
    const origin = receiverOrigin(expression);
    if (!origin) return undefined;
    if (ts.isClassExpression(origin)) return decorated(origin) ? undefined : origin;
    if (!ts.isIdentifier(origin) && !ts.isPropertyAccessExpression(origin)) return undefined;
    let symbol = symbolAt(origin);
    if (ts.isPropertyAccessExpression(origin)) {
      const receiver = receiverOrigin(origin.expression);
      const raw = receiver && symbolAt(receiver);
      const module = raw && resolveAlias(raw);
      if (!module || !(module.flags & ts.SymbolFlags.Module)) return undefined;
      symbol = exportedMember(module, origin.name.text);
    }
    const bound = symbol && resolveAlias(symbol);
    const declaration = bound && !writes.has(bound) ? bound.valueDeclaration : undefined;
    return declaration && ts.isClassLike(declaration) && !decorated(declaration) ? declaration : undefined;
  }

  function superclassOf(node: ts.Node): ts.ClassLikeDeclaration | undefined {
    let scope: ts.Node | undefined = node.parent;
    while (scope && !ts.isClassLike(scope)) scope = scope.parent;
    const base = scope?.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    return base && classTarget(base.expression);
  }

  function exactConstruction(expression: ts.Expression): boolean {
    let declaration = classTarget(expression);
    if (!declaration) return false;
    const initial = declaration;
    const cached = constructionChecks.get(initial);
    if (cached !== undefined) return cached;
    const seen = new Set<ts.ClassLikeDeclaration>();
    while (declaration) {
      if (seen.has(declaration) || !files.has(declaration.getSourceFile()) || constructorsReplacingThis.has(declaration)) break;
      seen.add(declaration);
      const base = declaration.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      if (!base) {
        constructionChecks.set(initial, true);
        return true;
      }
      declaration = classTarget(base.expression);
    }
    constructionChecks.set(initial, false);
    return false;
  }

  function constructorOf(declaration: ts.ClassLikeDeclaration): Target {
    if (external(declaration)) return { status: 'external' };
    if (decorated(declaration)) return unresolved('A decorator can replace the constructor');
    for (const member of declaration.members) {
      if (!ts.isConstructorDeclaration(member)) continue;
      const node = nodes.get(member);
      if (node) return { status: 'resolved', node };
    }
    return unresolved('The class has no project-defined constructor implementation');
  }

  function bind(
    initial: ts.Expression,
    constructing: boolean
  ): Target {
    let next: ts.Expression | ts.Symbol = initial;
    const visited = new Set<ts.Symbol>();
    for (;;) {
      if ('kind' in next) {
        const expression = unwrap(next);
        const node = nodes.get(expression);
        if (node) {
          return constructing && !canConstruct(expression)
            ? unresolved('The invoked callable cannot be constructed')
            : { status: 'resolved', node };
        }
        if (constructing && ts.isClassExpression(expression)) return constructorOf(expression);
        if (expression.kind === ts.SyntaxKind.SuperKeyword) {
          const baseClass = superclassOf(expression);
          return baseClass ? constructorOf(baseClass) : unresolved('The superclass constructor could not be resolved');
        }

        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
          const key = propertyKey(expression);
          if (key === undefined) return unresolved('The property key is selected at runtime');
          const originalSymbol = symbolAt(expression);
          const receiver = receiverOrigin(expression.expression);
          const originSymbol = receiver && symbolAt(receiver);
          if (originSymbol?.declarations?.some(isTypeOnlyAlias)) return unresolved('The receiver is a type-only import');
          const moduleSymbol = originSymbol && resolveAlias(originSymbol);
          const isNamespace = !!moduleSymbol && !!(moduleSymbol.flags & ts.SymbolFlags.Module);
          const receiverType = receiver && checker.getTypeAtLocation(receiver);
          const isStaticClass = receiver && classTarget(receiver);
          const exactInstance = receiver && ts.isNewExpression(receiver) && exactConstruction(receiver.expression);
          const privateMember = ts.isPropertyAccessExpression(expression) && ts.isPrivateIdentifier(expression.name);
          const exact = receiver && (exactInstance || ts.isObjectLiteralExpression(receiver)
            || (receiver.kind === ts.SyntaxKind.SuperKeyword && superclassOf(receiver)) || isNamespace || isRequire(receiver)
            || isStaticClass || (receiver.kind === ts.SyntaxKind.ThisKeyword && privateMember));
          if (receiverType?.symbol && dynamicWrites.has(canonical(receiverType.symbol))) {
            return unresolved('A computed write may replace the invoked member');
          }
          if (!exact) {
            if (originalSymbol?.declarations?.length && originalSymbol.declarations.every(external)) {
              return { status: 'external' };
            }
            const types = checker.getTypeAtLocation(expression.expression);
            const alternatives = types.isUnionOrIntersection() ? types.types : [types];
            const candidates = new Set<string>();
            for (const type of alternatives) {
              const member = checker.getPropertyOfType(type, key);
              for (const declaration of member?.declarations ?? []) {
                const initializer = initializerOf(declaration);
                const candidate = nodes.get(initializer ? unwrap(initializer) : declaration);
                if (candidate) candidates.add(candidate.id);
              }
            }
            return {
              status: candidates.size > 0 ? 'ambiguous' : 'unresolved',
              reason: 'The receiver may select a different implementation at runtime',
              ...(candidates.size > 0 && { candidates: [...candidates].sort() })
            };
          }

          // A const receiver can have a wider annotation than its actual initializer.
          const invoked = isNamespace && moduleSymbol
            ? exportedMember(moduleSymbol, key)
            : receiverType && !privateMember
              ? checker.getPropertyOfType(receiverType, key) ?? (receiver && isRequire(receiver) ? originalSymbol : undefined)
              : originalSymbol;
          if (invoked) {
            next = invoked;
            continue;
          }
          return unresolved('The compiler could not resolve the invoked member');
        }

        if (!ts.isIdentifier(expression)) return unresolved('The callee is selected by a runtime expression');
        const symbol = symbolAt(expression);
        if (!symbol) return unresolved('The compiler could not resolve the invoked value');
        next = symbol;
      }

      const bound = resolveAlias(next);
      if (!bound) return unresolved('The invoked import or alias does not resolve to a runtime value');
      if (visited.has(bound)) return unresolved('The callee follows a cyclic alias');
      if (writes.has(bound) || bound.declarations?.some(declaration => {
        const name = (declaration as ts.NamedDeclaration).name;
        const declared = name && checker.getSymbolAtLocation(name);
        return declared && writes.has(canonical(declared));
      })) return unresolved('The invoked binding is reassigned');
      visited.add(bound);

      const declarations = bound.declarations ?? [];
      if (declarations.length && declarations.every(external)) return { status: 'external' };
      if (declarations.some(declared => decorated(declared)
        || (ts.isClassLike(declared.parent) && decorated(declared.parent)))) {
        return unresolved('A decorator can replace the invoked member');
      }
      const implementation = declarations.flatMap(declaration => {
        const node = nodes.get(declaration);
        return node && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))
          ? [{ node, declaration }] : [];
      });
      if (implementation.length === 1) {
        const [{ node, declaration }] = implementation;
        return constructing && !canConstruct(declaration)
          ? unresolved('The invoked callable cannot be constructed')
          : { status: 'resolved', node };
      }
      if (implementation.length > 1) {
        return { status: 'ambiguous', reason: 'The compiler found multiple implementations',
          candidates: implementation.map(({ node }) => node.id).sort() };
      }

      const declaration = bound.valueDeclaration;
      if (!declaration) return unresolved('The compiler found no callable implementation');
      if (constructing && ts.isClassLike(declaration)) return constructorOf(declaration);
      if (ts.isParameter(declaration)) return unresolved('The callback target is supplied by the caller');
      if (ts.isVariableDeclaration(declaration) && !immutableVariable(declaration)) return unresolved('The invoked variable is mutable');
      const initializer = initializerOf(declaration);
      if (initializer) {
        next = initializer;
      } else if (ts.isShorthandPropertyAssignment(declaration)) {
        const value = checker.getShorthandAssignmentValueSymbol(declaration);
        if (!value) return unresolved('The compiler could not resolve the shorthand member');
        next = value;
      } else {
        return unresolved('The compiler found a declaration without a concrete callable implementation');
      }
    }
  }

  function callError(call: Call): ts.DiagnosticWithLocation | undefined {
    const source = call.getSourceFile();
    const errors = errorsByFile.get(source) ?? [];
    const start = call.getStart(source);
    const end = call.getEnd();
    let low = 0;
    let high = errors.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (errors[mid].start < start) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < errors.length && errors[i].start < end; i++) {
      const error = errors[i];
      // These errors make the signature a recovery candidate rather than a successful invocation.
      if (error.start < call.expression.getEnd() || error.start + (error.length ?? 0) <= end) return error;
    }
    return undefined;
  }

  for (const { target, assigned } of writeSites) {
    const source = target.getSourceFile();
    if (failedFiles.has(source)) continue;
    try {
      recordWrite(target, assigned);
    } catch (error) {
      if (!isCompilerRecursion(error)) throw error;
      failedFiles.add(source);
      diagnostics.push({ code: 0, reason: 'TypeScript exceeded its recursion limit while checking a write',
        at: atNode(files.get(source)!, target) });
    }
  }

  for (const { node, file, caller, initializer } of calls) {
    const expression = unwrap(node.expression);
    const constructing = ts.isNewExpression(node) || expression.kind === ts.SyntaxKind.SuperKeyword;
    const kind = constructing ? 'construct' : 'call';
    let signature: ts.SignatureDeclaration | ts.JSDocSignature | undefined;
    let target: Target;
    try {
      if (failedFiles.has(node.getSourceFile())) {
        target = unresolved('TypeScript could not finish checking this file');
      } else if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        target = unresolved('Dynamic module loading has no callable target');
      } else if (isRequire(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
        continue;
      } else {
        signature = checker.getResolvedSignature(node)?.getDeclaration();
        target = bind(expression, constructing);
      }
    } catch (error) {
      if (!isCompilerRecursion(error)) throw error;
      target = unresolved('TypeScript exceeded its recursion limit while resolving this call');
    }
    if (target.status === 'external') continue;
    const at = atNode(file, node);
    const error = callError(node);
    if (target.status !== 'resolved' || initializer || error) {
      unresolvedCalls.push({
        at, ...(caller && { caller }),
        status: target.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
        reason: target.status !== 'resolved' ? target.reason
          : error ? 'TypeScript rejected the call (TS' + error.code + ')'
          : 'The call originates in an instance field initializer',
        ...(target.status === 'ambiguous' && target.candidates && { candidates: target.candidates })
      });
      continue;
    }

    const callee = target.node.id;
    const evidence: CallEvidence = { at, target: target.node.declaration };
    if (signature && !nodes.has(signature)) {
      const signatureFile = files.get(signature.getSourceFile());
      if (signatureFile && (ts.isFunctionDeclaration(signature) || ts.isMethodDeclaration(signature)
        || ts.isConstructorDeclaration(signature)) && !signature.body) {
        evidence.signature = atNode(signatureFile, signature);
      }
    }
    if (!caller) {
      moduleCalls.push({ ...evidence, callee, kind });
      continue;
    }

    const id = JSON.stringify([caller, callee, kind]);
    let edge = edges.get(id);
    if (!edge) {
      edge = { id, caller, callee, kind, sites: [] };
      edges.set(id, edge);
    }
    edge.sites.push(evidence);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    moduleCalls,
    unresolved: unresolvedCalls,
    coverage: files.size === 0 ? 'unavailable'
      : unresolvedCalls.length || diagnostics.length || files.size !== graphNodes.length ? 'partial' : 'complete',
    diagnostics
  };
}

const invalidCallCodes = new Set([
  1361, 1362, 2341, 2345, 2348, 2349, 2350, 2351, 2554, 2555, 2673, 2684, 2722, 2769, 2775, 2776
]);

const diagnosticMessages = new Map<number, string>([
  [2307, 'A module or its type declarations could not be resolved'],
  [7016, 'A module has no type declaration file'],
  [18028, 'The compiler target does not support private identifiers'],
  [2769, 'No overload matches the supplied arguments'],
  [2630, 'A function declaration is assigned a new value'],
  [2688, 'A configured type library could not be loaded'],
  [5083, 'A TypeScript configuration file could not be read'],
  [5023, 'A TypeScript configuration option is unknown'],
  [6046, 'A TypeScript configuration value is invalid'],
  [1005, 'The parser expected a syntax token']
]);

