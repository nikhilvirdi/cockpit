import com.github.javaparser.*;
import com.github.javaparser.ast.*;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.ExplicitConstructorInvocationStmt;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.resolution.declarations.*;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.javaparsermodel.JavaParserFacade;
import com.github.javaparser.symbolsolver.resolution.typesolvers.*;
import com.google.gson.Gson;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

public final class Analyze {
    private final Path root;
    private final List<List<?>> files = new ArrayList<>(), callables = new ArrayList<>(),
        dependencies = new ArrayList<>(), calls = new ArrayList<>();
    private final Set<String> diagnostics = new TreeSet<>();
    private final Map<String, List<List<?>>> methods = new HashMap<>();
    private final Set<String> ambiguousTypes = new HashSet<>();
    private final CombinedTypeSolver solver = new CombinedTypeSolver(new ReflectionTypeSolver(true));
    private final long deadline = System.nanoTime() + java.time.Duration.ofSeconds(32).toNanos();

    Analyze(Path root) { this.root = root; }

    private String relative(Node node) {
        return node.findCompilationUnit().flatMap(CompilationUnit::getStorage).map(storage -> {
            Path file = storage.getPath().toAbsolutePath().normalize();
            return file.startsWith(root) ? root.relativize(file).toString().replace('\\', '/') : null;
        }).orElse(null);
    }

    private List<?> location(Node node) {
        String file = relative(node);
        return file == null ? null : node.getRange().map(range -> List.of(file, range.begin.line - 1,
            range.begin.column - 1, range.end.line - 1, range.end.column)).orElse(null);
    }

    private void dependency(Node at, Node target, String kind) {
        List<?> source = location(at);
        String supplier = relative(target);
        if (source != null && supplier != null && !source.get(0).equals(supplier) && !ambiguous(target)) {
            dependencies.add(List.of(source, supplier, kind));
        }
    }

    private boolean ambiguous(Node node) {
        Optional<TypeDeclaration> owner = node instanceof TypeDeclaration<?> type ? Optional.of(type)
            : node.findAncestor(TypeDeclaration.class);
        return owner.flatMap(TypeDeclaration::getFullyQualifiedName).filter(ambiguousTypes::contains).isPresent();
    }

    private List<?> caller(Node node) {
        for (Node parent = node.getParentNode().orElse(null); parent != null; parent = parent.getParentNode().orElse(null)) {
            if (parent instanceof LambdaExpr) return null;
            if (parent instanceof CallableDeclaration<?>) return location(parent);
            if (parent instanceof TypeDeclaration<?> || parent instanceof InitializerDeclaration) return null;
        }
        return null;
    }

    private boolean insideLambda(Node node) {
        for (Node parent = node.getParentNode().orElse(null); parent != null; parent = parent.getParentNode().orElse(null)) {
            if (parent instanceof LambdaExpr) return true;
            if (parent instanceof CallableDeclaration<?> || parent instanceof TypeDeclaration<?>) return false;
        }
        return false;
    }

    private void invocation(Node at, ResolvedMethodLikeDeclaration resolved, boolean nonvirtual) {
        List<?> loc = location(at);
        if (loc == null) return;
        Optional<Node> target = resolved.toAst();
        String kind = resolved instanceof ResolvedConstructorDeclaration ? "construct" : "call";
        if (target.isEmpty() || location(target.get()) == null) return;
        Node declaration = target.get();
        if (ambiguous(declaration)) {
            unresolved(at, kind);
            return;
        }
        dependency(at, declaration, "reference");
        List<?> destination = location(declaration);
        if (declaration instanceof MethodDeclaration method) {
            boolean finalClass = method.findAncestor(ClassOrInterfaceDeclaration.class)
                .map(ClassOrInterfaceDeclaration::isFinal).orElse(false);
            nonvirtual |= method.isStatic() || method.isPrivate() || method.isFinal() || finalClass;
            if (!nonvirtual || method.getBody().isEmpty()) {
                calls.add(Arrays.asList(loc, caller(at), null, kind, "Java resolved a declaration with potentially virtual dispatch.", destination));
                return;
            }
        }
        if (insideLambda(at) || !(declaration instanceof CallableDeclaration<?> callable)) return;
        List<List<?>> overloads = methods.getOrDefault(qualified(callable), List.of());
        calls.add(Arrays.asList(loc, caller(at), destination, kind, null, null, overloads.size() > 1 ? destination : null));
    }

    private static String qualified(CallableDeclaration<?> declaration) {
        return declaration.findAncestor(TypeDeclaration.class)
            .flatMap(TypeDeclaration::getFullyQualifiedName).map(owner -> owner + ".").orElse("") + declaration.getNameAsString();
    }

    private void unresolved(Node node, String kind) {
        List<?> loc = location(node);
        if (loc != null) calls.add(Arrays.asList(loc, caller(node), null, kind, "Java symbol resolution is incomplete for this call."));
    }

    private void inspect(CompilationUnit unit) {
        for (ImportDeclaration imported : unit.getImports()) {
            if (imported.isAsterisk() && !imported.isStatic()) continue;
            String target = imported.getNameAsString();
            if (imported.isStatic() && !imported.isAsterisk()) target = imported.getName().getQualifier().orElseThrow().asString();
            try {
                solver.solveType(target).toAst().ifPresent(node -> dependency(imported, node, "import"));
            } catch (RuntimeException error) {
                diagnostics.add("Some Java imports require additional source roots or classpath entries.");
            }
        }
        for (ClassOrInterfaceType type : unit.findAll(ClassOrInterfaceType.class)) {
            if (expired()) return;
            try {
                var resolved = type.resolve();
                if (resolved.isReferenceType()) resolved.asReferenceType().getTypeDeclaration()
                    .flatMap(ResolvedReferenceTypeDeclaration::toAst).ifPresent(node -> dependency(type, node, "reference"));
            } catch (RuntimeException error) {
                diagnostics.add("Some Java types require additional source roots or classpath entries.");
            }
        }
        for (MethodCallExpr call : unit.findAll(MethodCallExpr.class)) {
            if (expired()) return;
            try {
                invocation(call, call.resolve(), call.getScope().filter(Expression::isSuperExpr).isPresent());
            } catch (RuntimeException error) { unresolved(call, "call"); }
        }
        for (ObjectCreationExpr call : unit.findAll(ObjectCreationExpr.class)) {
            if (expired()) return;
            try { invocation(call, call.resolve(), true); }
            catch (RuntimeException error) { unresolved(call, "construct"); }
        }
        for (ExplicitConstructorInvocationStmt call : unit.findAll(ExplicitConstructorInvocationStmt.class)) {
            try { invocation(call, call.resolve(), true); }
            catch (RuntimeException error) { unresolved(call, "construct"); }
        }
    }

    private boolean expired() {
        if (System.nanoTime() < deadline) return false;
        diagnostics.add("Java symbol resolution reached its analysis budget.");
        return true;
    }

    Map<String, Object> analyze() throws Exception {
        List<Path> paths;
        try (Stream<Path> stream = Files.find(root, 64, (path, attrs) -> attrs.isRegularFile() && path.toString().endsWith(".java"))) {
            paths = stream.filter(path -> {
                for (Path part : root.relativize(path)) {
                    if (Set.of("build", "target", ".gradle", "node_modules").contains(part.toString())) return false;
                }
                return true;
            }).sorted().toList();
        }
        ParserConfiguration configuration = new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21);
        JavaParser parser = new JavaParser(configuration);
        List<CompilationUnit> units = new ArrayList<>();
        Set<Path> roots = new TreeSet<>();
        for (Path path : paths) {
            ParseResult<CompilationUnit> parsed = parser.parse(path);
            if (!parsed.isSuccessful() || parsed.getResult().isEmpty()) {
                diagnostics.add("Some Java source files could not be parsed.");
                continue;
            }
            var unit = parsed.getResult().get();
            unit.setStorage(path);
            units.add(unit);
            Path sourceRoot = path.getParent();
            String pkg = unit.getPackageDeclaration().map(declaration -> declaration.getNameAsString()).orElse("");
            String[] segments = pkg.isEmpty() ? new String[0] : pkg.split("\\.");
            for (int i = segments.length - 1; i >= 0 && sourceRoot != null; i--) {
                if (sourceRoot.getFileName() == null || !sourceRoot.getFileName().toString().equals(segments[i])) {
                    sourceRoot = null;
                    break;
                }
                sourceRoot = sourceRoot.getParent();
            }
            if (sourceRoot != null && sourceRoot.startsWith(root)) roots.add(sourceRoot);
        }
        MemoryTypeSolver projectTypes = new MemoryTypeSolver();
        solver.add(projectTypes);
        for (Path directory : roots) solver.add(new JavaParserTypeSolver(directory, configuration));
        Path jars = Path.of("/opt/cockpit/classpath");
        if (Files.isDirectory(jars)) try (var artifacts = Files.list(jars)) {
            for (Path jar : artifacts.filter(path -> path.toString().endsWith(".jar")).sorted().toList()) {
                solver.add(new JarTypeSolver(jar));
            }
        }
        JavaSymbolSolver resolver = new JavaSymbolSolver(solver);
        Map<String, List<TypeDeclaration<?>>> definitions = new HashMap<>();
        for (CompilationUnit unit : units) {
            resolver.inject(unit);
            for (TypeDeclaration<?> type : unit.findAll(TypeDeclaration.class)) {
                type.getFullyQualifiedName().ifPresent(name ->
                    definitions.computeIfAbsent(name, ignored -> new ArrayList<>()).add(type));
            }
            files.add(List.of(relative(unit), "java"));
            for (CallableDeclaration<?> declaration : unit.findAll(CallableDeclaration.class)) {
                List<?> at = location(declaration);
                if (at == null) continue;
                String kind = declaration instanceof ConstructorDeclaration ? "constructor"
                    : declaration instanceof MethodDeclaration method && method.isStatic() ? "static-method" : "method";
                String name = qualified(declaration);
                callables.add(List.of(at, name, kind));
                methods.computeIfAbsent(name, ignored -> new ArrayList<>()).add(at);
            }
        }
        for (var entry : definitions.entrySet()) {
            if (entry.getValue().size() != 1) {
                ambiguousTypes.add(entry.getKey());
                diagnostics.add("Multiple source roots define the same Java qualified type name.");
                continue;
            }
            try { projectTypes.addDeclaration(entry.getKey(), JavaParserFacade.get(solver).getTypeDeclaration(entry.getValue().getFirst())); }
            catch (RuntimeException ignored) { /* The source-root solver can still try the declaration. */ }
        }
        units.sort(Comparator.comparing(unit -> relative(unit).contains("/src/test/") || relative(unit).startsWith("src/test/")));
        for (CompilationUnit unit : units) {
            if (expired()) break;
            inspect(unit);
        }
        return Map.of("version", 1, "tool", "javaparser 3.27.1", "files", files, "callables", callables,
            "dependencies", dependencies, "calls", calls, "diagnostics", diagnostics);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1 || Runtime.version().feature() != 21) System.exit(64);
        System.out.println(new Gson().toJson(new Analyze(Path.of(args[0]).toRealPath()).analyze()));
    }
}
