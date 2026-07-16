export interface ParameterInfo {
  name: string;
  type: string;
  optional: boolean;
  hasDefault: boolean;
}

export interface FunctionSignature {
  name: string;
  parameters: ParameterInfo[];
  returnType: string;
  isAsync: boolean;
  jsDoc: string | undefined;
}

export interface InterfacePropertyInfo {
  name: string;
  type: string;
  optional: boolean;
}

export interface InterfaceInfo {
  name: string;
  properties: InterfacePropertyInfo[];
  extends: string[];
}

export interface ImportInfo {
  moduleSpecifier: string;
  namedImports: string[];
  defaultImport: string | undefined;
  namespaceImport: string | undefined;
  isTypeOnly: boolean;
}

export interface FileAstSummary {
  filePath: string;
  imports: ImportInfo[];
  exportedFunctions: FunctionSignature[];
  interfaces: InterfaceInfo[];
}
