import { ts } from 'ts-morph';

export function isCommonJsRequire(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'require') return false;
  // Without Node typings, TypeScript can leave the CommonJS global unbound.
  const declarations = checker.getSymbolAtLocation(expression)?.declarations;
  return !declarations?.some(declaration => {
    const file = declaration.getSourceFile();
    return !file.isDeclarationFile || !/(?:^|[\\/])@types[\\/]node(?:[\\/])/.test(file.fileName);
  });
}
