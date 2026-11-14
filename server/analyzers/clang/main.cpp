#include <clang/AST/RecursiveASTVisitor.h>
#include <clang/Frontend/CompilerInstance.h>
#include <clang/Index/USRGeneration.h>
#include <clang/Lex/Lexer.h>
#include <clang/Lex/PPCallbacks.h>
#include <clang/Basic/Version.h>
#include <clang/Tooling/CompilationDatabase.h>
#include <clang/Tooling/JSONCompilationDatabase.h>
#include <clang/Tooling/Tooling.h>
#include <llvm/Config/llvm-config.h>
#include <llvm/Support/CommandLine.h>
#include <llvm/Support/JSON.h>
#include <llvm/Support/MemoryBuffer.h>
#include <filesystem>
#include <map>
#include <set>

using namespace clang;
namespace fs = std::filesystem;
namespace json = llvm::json;

struct Output {
  struct Call {
    json::Array at;
    std::string caller, target, kind, reason;
    json::Array selected;
  };
  fs::path root;
  std::map<std::string, std::set<std::string>> files;
  std::map<std::string, std::set<std::string>> overloads;
  std::map<std::string, std::map<std::string, std::pair<json::Array, std::pair<std::string, std::string>>>> definitions;
  json::Array includes;
  std::vector<Call> calls;
  std::set<std::string> diagnostics;

  std::string relative(llvm::StringRef name) const {
    if (name.empty()) return {};
    auto result = fs::path(name.str()).lexically_normal().lexically_relative(root);
    if (result.empty() || *result.begin() == "..") return {};
    return result.generic_string();
  }
};

static std::string identity(const FunctionDecl *function) {
  if (!function) return {};
  if (auto *pattern = function->getTemplateInstantiationPattern()) function = pattern;
  llvm::SmallString<128> key;
  if (index::generateUSRForDecl(function->getCanonicalDecl(), key)) return {};
  return key.str().str();
}

struct Source {
  const SourceManager &sm;
  const LangOptions &lang;
  Output &out;
  std::pair<unsigned, unsigned> point(FileID id, unsigned offset) const {
    unsigned line = sm.getLineNumber(id, offset);
    unsigned col = sm.getColumnNumber(id, offset);
    auto bytes = sm.getBufferData(id).slice(offset - col + 1, offset);
    // Count Unicode scalar values. The host validates and converts to UTF-16.
    unsigned chars = 0;
    for (unsigned char ch : bytes) if ((ch & 0xc0) != 0x80) ++chars;
    return {line - 1, chars};
  }
  json::Array range(SourceRange range) const {
    auto start = sm.getFileLoc(range.getBegin());
    auto last = sm.getFileLoc(range.getEnd());
    auto end = Lexer::getLocForEndOfToken(last, 0, sm, lang);
    if (start.isInvalid() || end.isInvalid()) return {};
    auto a = sm.getDecomposedLoc(start), b = sm.getDecomposedLoc(end);
    if (a.first != b.first || b.second <= a.second) return {};
    auto file = out.relative(sm.getFilename(start));
    if (file.empty()) return {};
    auto [line, col] = point(a.first, a.second);
    auto [endLine, endCol] = point(b.first, b.second);
    return json::Array{file, line, col, endLine, endCol};
  }
};

class Includes : public PPCallbacks {
  Source source;
public:
  explicit Includes(Source source) : source(source) {}
  void InclusionDirective(SourceLocation hash, const Token &, llvm::StringRef, bool,
                          CharSourceRange name, OptionalFileEntryRef file, llvm::StringRef,
                          llvm::StringRef, const Module *, bool, SrcMgr::CharacteristicKind) override {
    if (!file) return;
    auto loc = source.range(SourceRange(hash, name.getEnd()));
    auto target = source.out.relative(file->getName());
    if (loc.empty() || target.empty()) return;
    auto mode = source.lang.CPlusPlus ? "cpp" : "c";
    source.out.files[target].insert(mode);
    source.out.files[loc[0].getAsString()->str()].insert(mode);
    source.out.includes.push_back(json::Array{std::move(loc), target, "include"});
  }
};

class Visitor : public RecursiveASTVisitor<Visitor> {
  Source source;
  std::string caller;
  void call(SourceRange range, const FunctionDecl *target, std::string kind, std::string reason = {}) {
    auto at = source.range(range);
    if (at.empty()) return;
    auto key = identity(target);
    if (key.empty() && reason.empty()) reason = "Clang could not establish a direct static call target.";
    json::Array selected;
    if (target) {
      source.out.overloads[target->getQualifiedNameAsString()].insert(key);
      selected = source.range(target->getSourceRange());
    }
    source.out.calls.push_back({std::move(at), caller, key, std::move(kind), std::move(reason), std::move(selected)});
  }
public:
  explicit Visitor(Source source) : source(source) {}
  bool TraverseFunctionDecl(FunctionDecl *decl) {
    return traverse(decl, [&] { return RecursiveASTVisitor::TraverseFunctionDecl(decl); });
  }
  bool TraverseCXXMethodDecl(CXXMethodDecl *decl) {
    return traverse(decl, [&] { return RecursiveASTVisitor::TraverseCXXMethodDecl(decl); });
  }
  bool TraverseCXXConstructorDecl(CXXConstructorDecl *decl) {
    return traverse(decl, [&] { return RecursiveASTVisitor::TraverseCXXConstructorDecl(decl); });
  }
  bool TraverseCXXDestructorDecl(CXXDestructorDecl *decl) {
    return traverse(decl, [&] { return RecursiveASTVisitor::TraverseCXXDestructorDecl(decl); });
  }
  bool TraverseLambdaExpr(LambdaExpr *) { return true; }
  template<class Traverse> bool traverse(FunctionDecl *decl, Traverse descend) {
    auto saved = std::move(caller);
    const auto at = source.range(decl->getSourceRange());
    caller = !at.empty() && decl->doesThisDeclarationHaveABody() && !decl->isImplicit() ? identity(decl) : "";
    if (!caller.empty()) {
      auto file = at[0].getAsString()->str();
      auto mode = source.lang.CPlusPlus ? "cpp" : "c";
      source.out.files[file].insert(mode);
      std::string kind = "function";
      if (isa<CXXConstructorDecl>(decl)) kind = "constructor";
      else if (auto *method = dyn_cast<CXXMethodDecl>(decl)) kind = method->isStatic() ? "static-method" : "method";
      auto key = llvm::formatv("{0}", json::Value(json::Array(at))).str();
      source.out.definitions[caller].try_emplace(key, at, std::make_pair(decl->getQualifiedNameAsString(), kind));
      source.out.overloads[decl->getQualifiedNameAsString()].insert(caller);
    }
    bool success = descend();
    caller = std::move(saved);
    return success;
  }
  bool VisitCallExpr(CallExpr *expr) {
    auto *target = expr->getDirectCallee();
    if (target && target->isInvalidDecl()) target = nullptr;
    if (auto *method = dyn_cast_or_null<CXXMethodDecl>(target)) {
      auto *member = dyn_cast<MemberExpr>(expr->getCallee()->IgnoreParenImpCasts());
      if (method->isVirtual() && !method->hasAttr<FinalAttr>() && !method->getParent()->hasAttr<FinalAttr>()
          && (!member || !member->hasQualifier())) {
        call(expr->getSourceRange(), target, "call", "Clang resolved a declaration with potentially virtual dispatch.");
        return true;
      }
    }
    call(expr->getSourceRange(), target, "call");
    return true;
  }
  bool VisitCXXConstructExpr(CXXConstructExpr *expr) {
    if (expr->getNumArgs() > 0 && !expr->getConstructor()->isImplicit()) {
      call(expr->getSourceRange(), expr->getConstructor(), "construct");
    }
    return true;
  }
};

class Action : public ASTFrontendAction {
  Output &out;
public:
  explicit Action(Output &out) : out(out) {}
  std::unique_ptr<ASTConsumer> CreateASTConsumer(CompilerInstance &compiler, llvm::StringRef input) override {
    struct Consumer : ASTConsumer {
      Source source;
      explicit Consumer(Source source) : source(source) {}
      void HandleTranslationUnit(ASTContext &context) override {
        if (!context.getDiagnostics().hasErrorOccurred()) Visitor(source).TraverseDecl(context.getTranslationUnitDecl());
      }
    };
    Source source{compiler.getSourceManager(), compiler.getLangOpts(), out};
    auto file = out.relative(input);
    if (!file.empty()) out.files[file].insert(compiler.getLangOpts().CPlusPlus ? "cpp" : "c");
    compiler.getPreprocessor().addPPCallbacks(std::make_unique<Includes>(source));
    return std::make_unique<Consumer>(source);
  }
};

static bool sourceFile(const fs::path &path) {
  auto ext = path.extension().string();
  return ext == ".c" || ext == ".cc" || ext == ".cpp" || ext == ".cxx";
}

static std::vector<std::string> safeFlags(const tooling::CompileCommand &command, const fs::path &root) {
  std::vector<std::string> flags;
  auto directory = fs::path(command.Directory).lexically_normal();
  auto relative = directory.lexically_relative(root);
  // Accept only portable relative paths and paths within the mounted snapshot.
  bool inside = !relative.empty() && *relative.begin() != "..";
  for (size_t i = 1; i < command.CommandLine.size(); ++i) {
    auto arg = llvm::StringRef(command.CommandLine[i]);
    if (arg == "-x" && i + 1 < command.CommandLine.size()) {
      auto mode = command.CommandLine[++i];
      if (mode == "c" || mode == "c++" || mode == "c-header" || mode == "c++-header")
        flags.insert(flags.end(), {"-x", mode});
      continue;
    }
    if ((arg == "-D" || arg == "-U") && i + 1 < command.CommandLine.size()) {
      flags.push_back(arg.str() + command.CommandLine[++i]);
      continue;
    }
    if (arg.starts_with("-std=") || (arg.starts_with("-D") && arg.size() > 2)
        || (arg.starts_with("-U") && arg.size() > 2)) {
      flags.push_back(arg.str());
      continue;
    }
    for (auto prefix : {"-I", "-iquote", "-isystem", "-include"}) {
      std::string argument;
      if (arg == prefix && i + 1 < command.CommandLine.size()) argument = command.CommandLine[++i];
      else if (arg.starts_with(prefix) && arg.size() > llvm::StringRef(prefix).size()) argument = arg.drop_front(strlen(prefix)).str();
      if (argument.empty()) continue;
      auto file = fs::path(argument);
      if (!file.is_absolute()) file = (inside ? directory : root) / file;
      auto rel = file.lexically_normal().lexically_relative(root);
      if (!rel.empty() && *rel.begin() != "..") flags.insert(flags.end(), {prefix, (root / rel).string()});
      break;
    }
  }
  return flags;
}

int main(int argc, char **argv) {
  if (argc != 2 || LLVM_VERSION_MAJOR != 19 || LLVM_VERSION_MINOR != 1 || LLVM_VERSION_PATCH != 7) return 64;
  Output out;
  out.root = fs::canonical(argv[1]);
  struct Factory : tooling::FrontendActionFactory {
    Output &out;
    explicit Factory(Output &out) : out(out) {}
    std::unique_ptr<FrontendAction> create() override { return std::make_unique<Action>(out); }
  } factory(out);
  std::map<fs::path, std::vector<std::string>> work;
  std::vector<fs::path> databases;
  for (fs::recursive_directory_iterator item(out.root, fs::directory_options::skip_permission_denied), end; item != end; ++item) {
    const auto &file = item->path();
    if (item->is_directory()) {
      auto name = file.filename().string();
      if (name.front() == '.' || name == "node_modules" || name == "dist" || name == "target")
        item.disable_recursion_pending();
    } else if (item->is_regular_file()) {
      auto relative = file.lexically_relative(out.root);
      if (sourceFile(file) && std::find(relative.begin(), relative.end(), "build") == relative.end()) work[file] = {};
      if (file.filename() == "compile_commands.json") databases.push_back(file);
    }
  }
  std::set<fs::path> configured;
  std::sort(databases.begin(), databases.end());
  for (const auto &database : databases) {
    if (fs::file_size(database) > 1024 * 1024) {
      out.diagnostics.insert("A Clang compilation database exceeded the size limit.");
      continue;
    }
    std::string diagnostic;
    auto db = tooling::JSONCompilationDatabase::loadFromFile(database.string(), diagnostic, tooling::JSONCommandLineSyntax::AutoDetect);
    if (db) for (const auto &cmd : db->getAllCompileCommands()) {
      auto file = (database.parent_path() / cmd.Directory / cmd.Filename).lexically_normal();
      auto candidate = work.find(file);
      if (candidate == work.end()) {
        auto relative = fs::path(cmd.Filename).lexically_normal();
        if (!relative.is_absolute()) candidate = work.find((database.parent_path() / relative).lexically_normal());
      }
      if (candidate == work.end()) continue;
      auto portable = cmd;
      portable.Directory = (database.parent_path() / cmd.Directory).lexically_normal().string();
      auto flags = safeFlags(portable, out.root);
      if (!configured.insert(candidate->first).second && candidate->second != flags) {
        candidate->second = {"--cockpit-ambiguous"};
        out.diagnostics.insert("Clang skipped translation units with conflicting compile commands.");
      } else candidate->second = std::move(flags);
    }
    else out.diagnostics.insert("Clang could not read compile_commands.json.");
  }
  if (configured.size() < work.size()) out.diagnostics.insert("Some translation units use Clang defaults because compilation metadata is missing or paths do not match.");
  for (auto &[file, flags] : work) {
    if (flags == std::vector<std::string>{"--cockpit-ambiguous"}) continue;
    flags.insert(flags.end(), {"-fsyntax-only", "-fno-modules", "-resource-dir=/usr/lib/llvm-19/lib/clang/19"});
    tooling::FixedCompilationDatabase db(out.root.string(), flags);
    tooling::ClangTool tool(db, {file.string()});
    IgnoringDiagConsumer quiet;
    tool.setDiagnosticConsumer(&quiet);
    if (tool.run(&factory)) out.diagnostics.insert("Some Clang translation units could not be compiled with available metadata and headers.");
  }
  json::Array files, callables, calls, diagnostics;
  for (auto &[file, modes] : out.files) {
    if (modes.size() == 1) files.push_back(json::Array{file, *modes.begin()});
    else out.diagnostics.insert("C/C++ header language is ambiguous for " + file + ".");
  }
  auto declaration = [&](const std::string &id) -> const json::Array * {
    auto found = out.definitions.find(id);
    if (found == out.definitions.end() || found->second.size() != 1) return nullptr;
    const auto &at = found->second.begin()->second.first;
    return out.files[at[0].getAsString()->str()].size() == 1 ? &at : nullptr;
  };
  for (const auto &[id, entries] : out.definitions) {
    if (auto at = declaration(id)) {
      const auto &[name, kind] = entries.begin()->second.second;
      callables.push_back(json::Array{json::Array(*at), name, kind});
    }
  }
  for (auto &call : out.calls) {
    auto caller = declaration(call.caller), target = declaration(call.target);
    if ((!call.caller.empty() && !caller) || out.files[call.at[0].getAsString()->str()].size() != 1) continue;
    if (!target && call.reason.empty()) continue;
    bool resolved = target && call.reason.empty();
    bool overloaded = resolved && out.overloads[out.definitions.at(call.target).begin()->second.second.first].size() > 1;
    calls.push_back(json::Array{std::move(call.at), caller ? json::Value(json::Array(*caller)) : nullptr,
      resolved ? json::Value(json::Array(*target)) : nullptr, call.kind,
      resolved ? json::Value(nullptr) : json::Value(call.reason),
      !resolved && target ? json::Value(json::Array(*target)) : nullptr,
      overloaded && !call.selected.empty() ? json::Value(std::move(call.selected)) : nullptr});
  }
  for (const auto &message : out.diagnostics) diagnostics.push_back(message);
  llvm::outs() << json::Value(json::Object{{"version", 1}, {"tool", "clang 19.1.7"}, {"files", std::move(files)},
    {"callables", std::move(callables)}, {"dependencies", std::move(out.includes)}, {"calls", std::move(calls)},
    {"diagnostics", std::move(diagnostics)}}) << "\n";
}
