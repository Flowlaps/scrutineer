import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { loadPersonaPrompt, type PersonaPrompt } from "./prompt-loader.js";

const MODEL_ID = process.env.SLIPSTREAM_MODEL ?? "claude-sonnet-5";

export interface ReviewInput {
  filePath: string;
  astContext: string;
  diff: string;
}

export interface ReviewResult {
  codeReview: string;
  securityAudit: string;
}

function buildUserPrompt(input: ReviewInput, priorFindings?: string): string {
  const sections = [
    `# File under review: ${input.filePath}`,
    "",
    "## AST Context",
    input.astContext,
    "",
    "## Diff",
    "```diff",
    input.diff,
    "```",
  ];

  if (priorFindings) {
    sections.push("", "## Code Reviewer Findings (prior pass)", priorFindings);
  }

  return sections.join("\n");
}

async function runPersona(persona: PersonaPrompt, userPrompt: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic(MODEL_ID),
    system: persona.systemPrompt,
    prompt: userPrompt,
  });
  return text;
}

export async function runReviewPipeline(input: ReviewInput): Promise<ReviewResult> {
  const [codeReviewer, securityAuditor] = await Promise.all([
    loadPersonaPrompt("code-reviewer"),
    loadPersonaPrompt("security-auditor"),
  ]);

  const codeReview = await runPersona(codeReviewer, buildUserPrompt(input));
  const securityAudit = await runPersona(
    securityAuditor,
    buildUserPrompt(input, codeReview),
  );

  return { codeReview, securityAudit };
}
