export type SkillCategory = "frontend" | "backend" | "config";

// Case-insensitive (`i`) since real-world filenames vary in case (e.g. a
// Windows checkout or a component named `Components/`) and none of these
// patterns are case-sensitive by convention.
const FRONTEND_PATTERNS = [/(^|\/)page\.tsx$/i, /(^|\/)layout\.tsx$/i, /(^|\/)components\//i];
const BACKEND_PATTERNS = [/(^|\/)route\.ts$/i, /(^|\/)schema\.ts$/i, /(^|\/)prisma\//i, /\.sql$/i];
const CONFIG_PATTERNS = [
  /(^|\/)package\.json$/i,
  /(^|\/)next\.config\.(ts|js|mjs)$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
];

// `.sql` files aren't `.ts`/`.tsx`, so getChangedFiles() (git-diff.ts) drops them
// before a --diff batch's changedFiles ever reaches this module — see
// isDynamicSkillTrigger() below, which git-diff.ts uses to keep them (and the
// CONFIG_PATTERNS filenames) in the batch instead of silently discarding them.
const SQL_PATTERN = /\.sql$/i;

// All patterns are anchored/linear with no nested quantifiers, so there's no
// ReDoS risk from running them against attacker-influenced file paths.
function matchesAny(patterns: RegExp[], filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some((pattern) => pattern.test(normalized));
}

// Filenames the dynamic skill router cares about that fall outside the
// .ts/.tsx extensions getChangedFiles() otherwise limits a --diff batch to.
// Without this, `package.json`, `next.config.js`/`.mjs`, lockfiles, and
// `*.sql` files never survive into changedFiles on the tool's primary --diff
// review path, making the "config" category and the SQL half of "backend"
// unreachable there (they'd only ever trigger via single-file review).
// Lockfiles in particular matter here beyond skill routing: if a dependency
// bump's lockfile update is invisible to the review, both personas tend to
// flag a false-positive "no lockfile update" finding (issue #27).
export function isDynamicSkillTrigger(filePath: string): boolean {
  return matchesAny(CONFIG_PATTERNS, filePath) || matchesAny([SQL_PATTERN], filePath);
}

const REACT_ARCHITECTURE_AND_PERFORMANCE = `## Dynamic Skill: React Architecture & Performance Auditor
This diff touches frontend/UI files. In addition to your standard review, specifically check for:
- Stale closures in effects or callbacks that capture outdated state or props
- Prop drilling that should instead be lifted into context or component composition
- Unoptimized images (missing next/image, missing width/height, unnecessarily large assets)
- Unnecessary re-renders from missing memoization or unstable inline references passed as props`;

const TYPE_WIZARD = `## Dynamic Skill: Type Wizard
This diff touches backend/data files. In addition to your standard review, specifically check for:
- \`any\` assertions or implicit \`any\` that erase type safety
- Missing or weak schema validation (e.g. Zod) on externally supplied payloads
- Type mismatches between schema definitions and how the data is actually used at runtime`;

const BACKEND_SECURITY_AUDIT = `## Dynamic Skill: Backend Security Auditor
This diff touches backend/data files. In addition to your standard audit, specifically check for:
- Unvalidated request payloads reaching business logic or the database
- Raw or string-concatenated SQL queries vulnerable to injection
- Missing authorization checks on data-mutating routes`;

const DEPENDENCY_AND_ENV_AUDIT = `## Dynamic Skill: Dependency & Environment Auditor
This diff touches configuration files. In addition to your standard audit, specifically check for:
- New or updated dependencies with known vulnerabilities or excessive install-time scripts
- Environment variables introduced without validation, defaults, or documentation
- Configuration changes that widen network/filesystem access or weaken security settings
- A lockfile changed without a corresponding \`package.json\` change, or vice versa — one may be stale relative to the other`;

export interface DynamicSkillInstructions {
  codeReviewerAdditions: string;
  securityAuditorAdditions: string;
  triggeredCategories: SkillCategory[];
}

// Reads only the changed file paths — never file contents — so an untrusted diff
// can't influence which specialized instructions get injected into the system
// prompt. Instructions are appended to whichever of the two existing personas
// (code-reviewer, security-auditor) they're most relevant to, rather than adding
// a third model call per triggered category, keeping the pipeline's shape fixed
// regardless of what the diff touches.
export function buildDynamicSkillInstructions(changedFiles: string[]): DynamicSkillInstructions {
  const isFrontend = changedFiles.some((file) => matchesAny(FRONTEND_PATTERNS, file));
  const isBackend = changedFiles.some((file) => matchesAny(BACKEND_PATTERNS, file));
  const isConfig = changedFiles.some((file) => matchesAny(CONFIG_PATTERNS, file));

  const codeReviewerParts: string[] = [];
  const securityAuditorParts: string[] = [];
  const triggeredCategories: SkillCategory[] = [];

  if (isFrontend) {
    codeReviewerParts.push(REACT_ARCHITECTURE_AND_PERFORMANCE);
    triggeredCategories.push("frontend");
  }
  if (isBackend) {
    codeReviewerParts.push(TYPE_WIZARD);
    securityAuditorParts.push(BACKEND_SECURITY_AUDIT);
    triggeredCategories.push("backend");
  }
  if (isConfig) {
    securityAuditorParts.push(DEPENDENCY_AND_ENV_AUDIT);
    triggeredCategories.push("config");
  }

  return {
    codeReviewerAdditions: codeReviewerParts.join("\n\n"),
    securityAuditorAdditions: securityAuditorParts.join("\n\n"),
    triggeredCategories,
  };
}
