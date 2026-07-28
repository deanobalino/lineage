import type {
  ArchitectureDecision,
  GitLineEvidence,
  LineExplanation,
  ProvenanceSession
} from "./models.js";
import { stableId } from "./stable.js";

function decisionFor(session: ProvenanceSession): ArchitectureDecision {
  const recorded = session.decisions[0];
  if (recorded) {
    return {
      context: recorded.context || session.prompt || "Captured provider session",
      decision:
        recorded.selectedOptionText ??
        recorded.freeformResponse ??
        "Decision recorded by provider.",
      alternatives: recorded.alternatives,
      evidence: recorded.evidence,
      consequences: recorded.consequences ?? "No consequences were recorded.",
      externalConstraints: session.externalConstraints
    };
  }
  return {
    context: session.prompt || "Captured provider session",
    decision: session.lastAssistantMessage || "No explicit decision record was captured.",
    alternatives: [],
    evidence: [session.source, ...session.toolsUsed],
    consequences: "No explicit consequences were captured.",
    externalConstraints: session.externalConstraints
  };
}

function providerAnswer(sessions: ProvenanceSession[], lineText: string): string {
  const names = [...new Set(sessions.map((session) => session.providerDisplayName))].sort();
  const first = sessions[0];
  if (!first) return "No provider provenance was captured.";
  const action = first.prompt || first.reasoningSummary || first.lastAssistantMessage;
  return `${names.join(" and ")} provenance links this line${lineText ? ` (${lineText.trim()})` : ""} to the captured session${action ? `: ${action}` : "."}`;
}

export interface ExplainLineInput {
  file: string;
  line: number;
  lineText: string;
  sessions: ProvenanceSession[];
  gitEvidence?: GitLineEvidence;
  referencesCount?: number;
}

export function explainLine(input: ExplainLineInput): LineExplanation {
  const session = input.sessions[0];
  if (!session) {
    const answer =
      "No AI provider provenance was captured for this line. This explanation is inferred from Git history only.";
    const result: LineExplanation = {
      file: input.file,
      line: input.line,
      answer,
      confidence: 0.42,
      decisionProvenance: {
        label: "No AI provider provenance captured",
        detail:
          "Lineage can see Git history for this line, but no captured provider session matched it.",
        evidence: ["Git blame"]
      },
      architectureDecision: {
        context: "Git history only",
        decision: input.gitEvidence
          ? `Decision maker unknown; inferred from Git commit ${input.gitEvidence.commitSha}.`
          : "Decision maker unknown.",
        alternatives: [],
        evidence: input.gitEvidence ? [input.gitEvidence.commitSha] : [],
        consequences: "Unknown from captured evidence.",
        externalConstraints: []
      },
      timeline: ["Git blame", "Commit diff", "Line selected"],
      evidenceCards: [
        {
          id: "git",
          title: "Git evidence",
          kind: "Inferred only",
          body: input.gitEvidence
            ? `${input.gitEvidence.commitSha} ${input.gitEvidence.commitSummary}`
            : "No blame data available."
        }
      ],
      removalAssessment:
        "Removal risk is unknown because no recorded provider evidence matched this line.",
      suggestedQuestions: ["What evidence supports this?", "Show the Git history", "What tests should I run?"]
    };
    if (input.gitEvidence) result.gitEvidence = input.gitEvidence;
    return result;
  }

  const architectureDecision = decisionFor(session);
  const providerNames = [...new Set(input.sessions.map((item) => item.providerDisplayName))].sort();
  const evidenceCards = input.sessions.flatMap((item) => [
    {
      id: stableId("evidence", item.sessionId, "prompt"),
      title: "Original prompt",
      kind: `${item.providerDisplayName} event`,
      body: item.prompt || "No prompt captured."
    },
    {
      id: stableId("evidence", item.sessionId, "tests"),
      title: "Tests",
      kind: "Test result",
      body: `${item.testsRun.join("\n")}\nResult: ${item.testsResult}`
    },
    {
      id: stableId("evidence", item.sessionId, "final"),
      title: "Final provider message",
      kind: `${item.providerDisplayName} final message`,
      body: item.lastAssistantMessage || "No final message captured."
    }
  ]);
  const explanation: LineExplanation = {
    file: input.file,
    line: input.line,
    answer: providerAnswer(input.sessions, input.lineText),
    confidence: session.source === "codex-transcript-recovery" ? 0.82 : 0.96,
    provider: providerNames.join(", "),
    sessionId: session.sessionId,
    decisionProvenance: {
      label:
        input.sessions.length > 1
          ? "Recorded multi-harness provenance"
          : `Recorded ${session.providerDisplayName} provenance`,
      detail: architectureDecision.decision,
      evidence: architectureDecision.evidence
    },
    architectureDecision,
    timeline: [
      "Prompt captured",
      ...session.toolsUsed.map((tool) => `Tool: ${tool}`),
      ...session.testsRun.map((test) => `Test: ${test}`),
      "Final provider message captured"
    ],
    evidenceCards,
    removalAssessment:
      session.testsResult === "passed"
        ? `Medium risk. ${input.referencesCount ?? 0} references found and captured tests passed.`
        : `Unknown risk. ${input.referencesCount ?? 0} references found and test coverage is ${session.testsResult}.`,
    suggestedQuestions: [
      "What evidence supports this?",
      "Could this be feature flagged?",
      "Explain this to a staff engineer",
      "Generate a cleanup PR plan"
    ]
  };
  if (input.gitEvidence) explanation.gitEvidence = input.gitEvidence;
  return explanation;
}

export function answerFollowUp(question: string, explanation: LineExplanation): string {
  if (/evidence|support/i.test(question)) {
    return explanation.evidenceCards
      .map((card) => `${card.title}: ${card.body}`)
      .join("\n\n");
  }
  if (/feature.?flag/i.test(question)) {
    return "A safe next step is to place the behavior behind configuration, add telemetry, and compare outcomes before removing the old path.";
  }
  if (/tests?/i.test(question)) {
    return `Run the tests named in the captured evidence, then add a focused regression around ${explanation.file}:${explanation.line}.`;
  }
  return explanation.answer;
}
