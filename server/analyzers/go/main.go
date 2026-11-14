package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/mod/modfile"
	"golang.org/x/tools/go/packages"
)

type result struct {
	Version      int      `json:"version"`
	Tool         string   `json:"tool"`
	Files        [][]any  `json:"files"`
	Callables    [][]any  `json:"callables"`
	Packages     [][]any  `json:"packages"`
	Dependencies [][]any  `json:"dependencies"`
	Calls        [][]any  `json:"calls"`
	Diagnostics  []string `json:"diagnostics"`
}

func main() {
	if len(os.Args) != 2 || !strings.HasPrefix(runtime.Version(), "go1.27.") {
		os.Exit(64)
	}
	root, err := filepath.Abs(os.Args[1])
	if err != nil {
		os.Exit(1)
	}
	out := result{Version: 1, Tool: "go/packages v0.52.0"}
	relative := func(file string) string {
		name, err := filepath.Rel(root, file)
		if err != nil || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return ""
		}
		return filepath.ToSlash(name)
	}
	fset := token.NewFileSet()
	sources := map[string][]byte{}
	location := func(start, end token.Pos) []any {
		a, b := fset.PositionFor(start, false), fset.PositionFor(end, false)
		rel := relative(a.Filename)
		bytes, ok := sources[a.Filename]
		if !a.IsValid() || !b.IsValid() || a.Filename != b.Filename || rel == "" || !ok {
			return nil
		}
		return []any{rel, a.Line - 1, utf8.RuneCount(bytes[a.Offset-a.Column+1 : a.Offset]),
			b.Line - 1, utf8.RuneCount(bytes[b.Offset-b.Column+1 : b.Offset])}
	}
	directories := []string{}
	workspaces := map[string]string{}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if path != root && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "vendor" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		switch entry.Name() {
		case "go.mod":
			directories = append(directories, filepath.Dir(path))
		case "go.work":
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			if work, err := modfile.ParseWork(path, data, nil); err == nil {
				for _, use := range work.Use {
					dir := filepath.FromSlash(use.Path)
					if !filepath.IsAbs(dir) {
						dir = filepath.Join(filepath.Dir(path), dir)
					}
					dir = filepath.Clean(dir)
					if relative(dir) != "" {
						if previous := workspaces[dir]; len(previous) < len(path) {
							workspaces[dir] = path
						}
					}
				}
			}
		}
		return nil
	})
	if len(directories) == 0 {
		directories = append(directories, root)
	}
	sort.Strings(directories)
	seen := map[string]bool{}
	diagnostics := map[string]bool{}
	for _, directory := range directories {
		env := append(os.Environ(), "GOPROXY=off", "GOSUMDB=off", "GOVCS=*:off", "GOTOOLCHAIN=local", "GOENV=off",
			"CGO_ENABLED=0", "GOPACKAGESDRIVER=off", "GOFLAGS=-mod=readonly")
		if work := workspaces[directory]; work != "" {
			env = append(env, "GOWORK="+work)
		} else {
			env = append(env, "GOWORK=off")
		}
		cfg := &packages.Config{Dir: directory, Fset: fset, Env: env, Mode: packages.LoadAllSyntax | packages.NeedModule,
			ParseFile: func(files *token.FileSet, filename string, src []byte) (*ast.File, error) {
				tree, err := parser.ParseFile(files, filename, src, parser.SkipObjectResolution)
				return tree, err
			}}
		loaded, err := packages.Load(cfg, "./...")
		if err != nil || len(loaded) == 0 {
			diagnostics["Go could not load a module or workspace with the installed offline toolchain."] = true
			continue
		}
		var project []*packages.Package
		packages.Visit(loaded, func(pkg *packages.Package) bool {
			for _, filename := range pkg.GoFiles {
				if relative(filename) != "" {
					project = append(project, pkg)
					break
				}
			}
			return true
		}, nil)
		decls := map[types.Object][]any{}
		pkgIDs := map[*packages.Package]string{}
		for _, pkg := range project {
			if len(pkg.Errors) > 0 || pkg.IllTyped {
				diagnostics["Some Go packages have compiler errors or missing offline dependencies."] = true
			}
			if pkg.TypesInfo == nil {
				continue
			}
			for _, tree := range pkg.Syntax {
				filename := fset.PositionFor(tree.Pos(), false).Filename
				rel := relative(filename)
				if rel == "" {
					continue
				}
				bytes, err := os.ReadFile(filename)
				if err != nil {
					continue
				}
				sources[filename] = bytes
				moduleRoot := directory
				if pkg.Module != nil {
					moduleRoot = pkg.Module.Dir
					if pkg.Module.Replace != nil && pkg.Module.Replace.Dir != "" {
						moduleRoot = pkg.Module.Replace.Dir
					}
				}
				if relative(moduleRoot) != "" {
					key, _ := json.Marshal([]string{relative(moduleRoot), pkg.PkgPath})
					pkgIDs[pkg] = string(key)
				}
				for _, declaration := range tree.Decls {
					function, ok := declaration.(*ast.FuncDecl)
					if !ok || function.Body == nil {
						continue
					}
					if object, ok := pkg.TypesInfo.Defs[function.Name].(*types.Func); ok {
						decls[object.Origin()] = location(function.Pos(), function.End())
					}
				}
			}
		}
		for _, pkg := range project {
			// A dependency may be visited again from its own module with a different type universe.
			id := pkgIDs[pkg]
			if id == "" || seen[id] || pkg.TypesInfo == nil {
				continue
			}
			seen[id] = true
			var packageFiles []string
			for _, tree := range pkg.Syntax {
				if file := relative(fset.PositionFor(tree.Pos(), false).Filename); file != "" {
					packageFiles = append(packageFiles, file)
				}
			}
			sort.Strings(packageFiles)
			out.Packages = append(out.Packages, []any{id, pkg.PkgPath, packageFiles})
			for _, tree := range pkg.Syntax {
				file := relative(fset.PositionFor(tree.Pos(), false).Filename)
				if file == "" {
					continue
				}
				out.Files = append(out.Files, []any{file, "go"})
				for _, spec := range tree.Imports {
					name, _ := strconv.Unquote(spec.Path.Value)
					if target := pkgIDs[pkg.Imports[name]]; target != "" {
						out.Dependencies = append(out.Dependencies, []any{location(spec.Pos(), spec.End()), target, "package"})
					}
				}
				for _, declaration := range tree.Decls {
					function, ok := declaration.(*ast.FuncDecl)
					if !ok || function.Body == nil {
						continue
					}
					kind, name := "function", function.Name.Name
					if function.Recv != nil {
						kind = "method"
						if object, ok := pkg.TypesInfo.Defs[function.Name].(*types.Func); ok {
							if signature := object.Signature(); signature.Recv() != nil {
								name = types.TypeString(signature.Recv().Type(), func(*types.Package) string { return "" }) + "." + name
							}
						}
					}
					caller := location(function.Pos(), function.End())
					out.Callables = append(out.Callables, []any{caller, name, kind})
					ast.Inspect(function.Body, func(node ast.Node) bool {
						if _, nested := node.(*ast.FuncLit); nested {
							return false
						}
						call, ok := node.(*ast.CallExpr)
						if !ok {
							return true
						}
						target := called(pkg.TypesInfo, call.Fun)
						at := location(call.Pos(), call.End())
						if target != nil && decls[target.Origin()] != nil && !pkg.IllTyped {
							out.Calls = append(out.Calls, []any{at, caller, decls[target.Origin()], "call"})
						} else if target == nil {
							value := pkg.TypesInfo.Types[call.Fun]
							if !value.IsBuiltin() && !value.IsType() {
								out.Calls = append(out.Calls, []any{at, caller, nil, "call", "Go could not establish a concrete static call target."})
							}
						}
						return true
					})
				}
			}
		}
	}
	for message := range diagnostics {
		out.Diagnostics = append(out.Diagnostics, message)
	}
	sort.Strings(out.Diagnostics)
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		os.Exit(1)
	}
}

func called(info *types.Info, expression ast.Expr) *types.Func {
	switch expr := ast.Unparen(expression).(type) {
	case *ast.Ident:
		value, _ := info.Uses[expr].(*types.Func)
		return value
	case *ast.SelectorExpr:
		if selection := info.Selections[expr]; selection != nil {
			if types.IsInterface(selection.Recv()) {
				return nil
			}
			value, _ := selection.Obj().(*types.Func)
			if value != nil && value.Signature().Recv() != nil && types.IsInterface(value.Signature().Recv().Type()) {
				return nil
			}
			return value
		}
		value, _ := info.Uses[expr.Sel].(*types.Func)
		return value
	case *ast.IndexExpr:
		if isInstantiation(info, expr.X) {
			return called(info, expr.X)
		}
	case *ast.IndexListExpr:
		if isInstantiation(info, expr.X) {
			return called(info, expr.X)
		}
	}
	return nil
}

func isInstantiation(info *types.Info, expression ast.Expr) bool {
	if selector, ok := expression.(*ast.SelectorExpr); ok {
		expression = selector.Sel
	}
	identifier, ok := expression.(*ast.Ident)
	if !ok {
		return false
	}
	_, exists := info.Instances[identifier]
	return exists
}
