"""Analyze Python source without importing project modules."""
import ast
from collections import defaultdict
import io
import json
import os
from pathlib import Path
import sys
import tokenize

import jedi


def analyze(root):
    result = dict(version=1, tool="jedi 0.19.2", files=[], callables=[], dependencies=[], calls=[], diagnostics=[])
    projects = {}
    scripts = {}
    declarations = {}
    constructors = {}
    scopes = {}
    mutable_members = set()

    def report(message):
        if message not in result["diagnostics"] and len(result["diagnostics"]) < 100:
            result["diagnostics"].append(message)

    def relative(file):
        try:
            return Path(file).resolve().relative_to(root).as_posix()
        except (ValueError, TypeError):
            return None

    for directory, folders, names in os.walk(root):
        folders[:] = sorted(folder for folder in folders if not folder.startswith(".")
                            and folder not in {"__pycache__", "node_modules", "dist", "build", "target", "venv"})
        for name in sorted(names):
            if not name.endswith(".py"):
                continue
            file = Path(directory, name)
            rel = relative(file)
            try:
                with tokenize.open(file) as stream:
                    source = stream.read()
                tree = ast.parse(source, filename=rel)
                tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
            except (SyntaxError, UnicodeError, OSError, tokenize.TokenError):
                report(f"Python could not parse {rel}.")
                continue
            rows = source.splitlines()
            result["files"].append([rel, "python"])
            project_root = root
            for parent in file.parents:
                if parent == root or any((parent / marker).is_file() for marker in ("pyproject.toml", "setup.cfg", "setup.py")):
                    project_root = parent
                    break
            if project_root not in projects:
                search = [str(p) for p in (project_root / "src", project_root) if p.is_dir()]
                projects[project_root] = jedi.Project(project_root, environment_path=sys.prefix,
                    load_unsafe_extensions=False, sys_path=search, smart_sys_path=False)
            project = projects[project_root]
            scripts[rel] = (jedi.Script(source, path=file, project=project), tree, rows, tokens)

    def position(rows, line, byte):
        return len(rows[line - 1].encode("utf-8")[:byte].decode("utf-8"))

    def location(file, rows, node):
        return [file, node.lineno - 1, position(rows, node.lineno, node.col_offset),
                node.end_lineno - 1, position(rows, node.end_lineno, node.end_col_offset)]

    class Declarations(ast.NodeVisitor):
        def __init__(self, file, rows, tokens):
            self.file, self.rows = file, rows
            self.stack = []
            self.names = {token.start: tokens[i + 1].start for i, token in enumerate(tokens[:-1])
                          if token.type == tokenize.NAME and token.string in {"def", "class"}}

        def visit_ClassDef(self, node):
            self.stack.append(node)
            self.generic_visit(node)
            self.stack.pop()

        def visit_FunctionDef(self, node):
            loc = location(self.file, self.rows, node)
            owner = self.stack[-1] if self.stack else None
            method = isinstance(owner, ast.ClassDef)
            decorators = [d.id for d in node.decorator_list if isinstance(d, ast.Name)]
            static = decorators == ["staticmethod"] and len(node.decorator_list) == 1
            if static:
                decorator = node.decorator_list[0]
                try:
                    binding = scripts[self.file][0].goto(decorator.lineno, position(self.rows, decorator.lineno, decorator.col_offset))
                    static = bool(binding) and all(item.module_name == "builtins" for item in binding)
                except (ValueError, TypeError, NotImplementedError, RecursionError):
                    static = False
            constructor = method and node.name == "__init__"
            kind = "constructor" if constructor else "static-method" if method and static else "method" if method else "function"
            result["callables"].append([loc, ".".join([item.name for item in self.stack] + [node.name]), kind])
            scopes[node] = loc
            name_at = self.names.get((node.lineno, loc[2] + (6 if isinstance(node, ast.AsyncFunctionDef) else 0)))
            if name_at:
                declarations[(self.file, *name_at)] = (loc, node.name, bool(node.decorator_list) and not static or method and not static and not constructor)
            if constructor and not node.decorator_list and not owner.decorator_list and not owner.keywords \
                    and not owner.bases and not any(isinstance(item, ast.FunctionDef) and item.name == "__new__" for item in owner.body):
                key = self.names.get((owner.lineno, position(self.rows, owner.lineno, owner.col_offset)))
                if key:
                    constructors[(self.file, *key)] = (loc, owner.name, False)
            self.stack.append(node)
            self.generic_visit(node)
            self.stack.pop()

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_Attribute(self, node):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                mutable_members.add(node.attr)
            self.generic_visit(node)

    for file, (_, tree, rows, tokens) in scripts.items():
        Declarations(file, rows, tokens).visit(tree)

    for file, (script, tree, rows, tokens) in scripts.items():
        tokens_by_line = defaultdict(list)
        for token in tokens:
            if token.type == tokenize.NAME:
                tokens_by_line[token.start[0]].append(token)
        def targets(line, col):
            try:
                return script.goto(line, col, follow_imports=True)
            except (ValueError, TypeError, NotImplementedError, RecursionError):
                report(f"Jedi could not resolve some references in {file}.")
                return []

        class Calls(ast.NodeVisitor):
            caller = None
            deferred = False

            def visit_FunctionDef(self, node):
                for expression in [*node.decorator_list, *node.args.defaults, *filter(None, node.args.kw_defaults)]:
                    self.visit(expression)
                saved, deferred = self.caller, self.deferred
                self.caller, self.deferred = scopes[node], False
                for statement in node.body:
                    self.visit(statement)
                self.caller, self.deferred = saved, deferred

            visit_AsyncFunctionDef = visit_FunctionDef

            def visit_Lambda(self, node):
                saved = self.deferred
                self.deferred = True
                self.visit(node.body)
                self.deferred = saved

            def visit_Call(self, node):
                loc = location(file, rows, node)
                func = node.func
                found = []
                direct_receiver = True
                if isinstance(func, ast.Name):
                    found = targets(func.lineno, position(rows, func.lineno, func.col_offset))
                elif isinstance(func, ast.Attribute):
                    found = targets(func.end_lineno, position(rows, func.end_lineno, func.end_col_offset) - len(func.attr))
                    receiver = func.value
                    if isinstance(receiver, ast.Name):
                        owners = targets(receiver.lineno, position(rows, receiver.lineno, receiver.col_offset))
                        direct_receiver = len(owners) == 1 and owners[0].type in {"module", "class"}
                    else:
                        direct_receiver = False
                candidates = []
                kind = "call"
                external = bool(found)
                for item in found:
                    target_file = relative(item.module_path)
                    external = external and target_file is None
                    key = (target_file, item.line, item.column)
                    if key in constructors:
                        kind = "construct"
                        candidates.append(constructors[key])
                    elif key in declarations:
                        candidates.append(declarations[key])
                if candidates and len(found) == 1 and direct_receiver and not candidates[0][2] and not self.deferred \
                        and candidates[0][1] not in mutable_members:
                    result["calls"].append([loc, self.caller, candidates[0][0], kind])
                elif not external:
                    result["calls"].append([loc, self.caller, None, kind,
                        "Python dispatch is ambiguous." if candidates else "Jedi could not establish a project call target."])
                self.generic_visit(node)

            def visit_Import(self, node):
                loc = location(file, rows, node)
                for token in (token for line in range(node.lineno, node.end_lineno + 1) for token in tokens_by_line[line]):
                    if token.string in {"from", "import", "as"}:
                        continue
                    if not ((node.lineno, loc[2]) <= token.start < (node.end_lineno, loc[4])):
                        continue
                    for item in targets(*token.start):
                        target = relative(item.module_path)
                        if target in scripts and target != file:
                            result["dependencies"].append([loc, target, "import"])

            visit_ImportFrom = visit_Import

        Calls().visit(tree)
    return result


if __name__ == "__main__":
    if jedi.__version__ != "0.19.2" or sys.version_info[:2] != (3, 13):
        sys.exit("Expected Python 3.13 and Jedi 0.19.2")
    print(json.dumps(analyze(Path(sys.argv[1]).resolve()), ensure_ascii=True))
