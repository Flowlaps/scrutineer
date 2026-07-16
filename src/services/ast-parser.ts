import { Project, Node, type ParameterDeclaration, type SourceFile } from "ts-morph";
import type {
  FileAstSummary,
  FunctionSignature,
  ImportInfo,
  InterfaceInfo,
  ParameterInfo,
} from "../types/ast.js";

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: {
    allowJs: true,
  },
});

function extractImports(sourceFile: SourceFile): ImportInfo[] {
  return sourceFile.getImportDeclarations().map((decl) => ({
    moduleSpecifier: decl.getModuleSpecifierValue(),
    namedImports: decl.getNamedImports().map((named) => named.getName()),
    defaultImport: decl.getDefaultImport()?.getText(),
    namespaceImport: decl.getNamespaceImport()?.getText(),
    isTypeOnly: decl.isTypeOnly(),
  }));
}

function extractParameters(params: ParameterDeclaration[]): ParameterInfo[] {
  return params.map((param) => ({
    name: param.getName(),
    type: param.getTypeNode()?.getText() ?? param.getType().getText(),
    optional: param.isOptional(),
    hasDefault: param.hasInitializer(),
  }));
}

function extractExportedFunctions(sourceFile: SourceFile): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];

  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const jsDocs = fn.getJsDocs();
    signatures.push({
      name: fn.getName() ?? "<anonymous>",
      parameters: extractParameters(fn.getParameters()),
      returnType: fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText(),
      isAsync: fn.isAsync(),
      jsDoc: jsDocs.at(0)?.getDescription().trim() || undefined,
    });
  }

  for (const varStatement of sourceFile.getVariableStatements()) {
    if (!varStatement.isExported()) continue;
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (
        initializer &&
        (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
      ) {
        const jsDocs = varStatement.getJsDocs();
        signatures.push({
          name: decl.getName(),
          parameters: extractParameters(initializer.getParameters()),
          returnType:
            initializer.getReturnTypeNode()?.getText() ?? initializer.getReturnType().getText(),
          isAsync: initializer.isAsync(),
          jsDoc: jsDocs.at(0)?.getDescription().trim() || undefined,
        });
      }
    }
  }

  return signatures;
}

function extractInterfaces(sourceFile: SourceFile): InterfaceInfo[] {
  return sourceFile.getInterfaces().map((iface) => ({
    name: iface.getName(),
    properties: iface.getProperties().map((prop) => ({
      name: prop.getName(),
      type: prop.getTypeNode()?.getText() ?? prop.getType().getText(),
      optional: prop.hasQuestionToken(),
    })),
    extends: iface.getExtends().map((ext) => ext.getText()),
  }));
}

export function parseFile(filePath: string): FileAstSummary {
  const sourceFile = project.addSourceFileAtPath(filePath);

  return {
    filePath,
    imports: extractImports(sourceFile),
    exportedFunctions: extractExportedFunctions(sourceFile),
    interfaces: extractInterfaces(sourceFile),
  };
}

export function summaryToMarkdown(summary: FileAstSummary): string {
  const lines: string[] = [];

  lines.push(`# AST Summary: \`${summary.filePath}\``);

  if (summary.imports.length > 0) {
    lines.push("", "## Imports");
    for (const imp of summary.imports) {
      const parts: string[] = [];
      if (imp.defaultImport) parts.push(imp.defaultImport);
      if (imp.namespaceImport) parts.push(`* as ${imp.namespaceImport}`);
      if (imp.namedImports.length > 0) parts.push(`{ ${imp.namedImports.join(", ")} }`);
      const prefix = imp.isTypeOnly ? "import type" : "import";
      lines.push(`- \`${prefix} ${parts.join(", ")} from "${imp.moduleSpecifier}"\``);
    }
  }

  if (summary.exportedFunctions.length > 0) {
    lines.push("", "## Exported Functions");
    for (const fn of summary.exportedFunctions) {
      const params = fn.parameters
        .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
        .join(", ");
      const asyncPrefix = fn.isAsync ? "async " : "";
      lines.push(`- \`${asyncPrefix}${fn.name}(${params}): ${fn.returnType}\``);
      if (fn.jsDoc) lines.push(`  - ${fn.jsDoc}`);
    }
  }

  if (summary.interfaces.length > 0) {
    lines.push("", "## Interfaces");
    for (const iface of summary.interfaces) {
      const extendsClause = iface.extends.length > 0 ? ` extends ${iface.extends.join(", ")}` : "";
      lines.push(`- \`interface ${iface.name}${extendsClause}\``);
      for (const prop of iface.properties) {
        lines.push(`  - \`${prop.name}${prop.optional ? "?" : ""}: ${prop.type}\``);
      }
    }
  }

  return lines.join("\n");
}
