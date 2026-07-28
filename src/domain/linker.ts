import type {
  DecisionOption,
  DecisionRecord,
  ExternalConstraint,
  JsonValue,
  LineageEvent,
  LineRange,
  ProvenanceSession
} from "./models.js";
import { canonicalEventTypes, providerDisplayName } from "./models.js";
import { ProvenanceStore } from "./provenance-store.js";
import { compareEvents, stableId, uniqueSorted } from "./stable.js";

function payloadString(event: LineageEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function payloadStrings(event: LineageEvent, key: string): string[] | undefined {
  const value = event.payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function payloadObject(event: LineageEvent, key: string): Record<string, JsonValue> | undefined {
  const value = event.payload[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function payloadOptions(event: LineageEvent): DecisionOption[] {
  const value = event.payload["options_presented"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (typeof candidate === "string") {
      return [{ id: stableId("option", event.id, index), text: candidate }];
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const text = candidate["text"];
    if (typeof text !== "string") return [];
    const option: DecisionOption = {
      id: typeof candidate["id"] === "string" ? candidate["id"] : stableId("option", event.id, index),
      text
    };
    if (typeof candidate["rationale"] === "string") option.rationale = candidate["rationale"];
    return [option];
  });
}

function payloadConstraints(event: LineageEvent): ExternalConstraint[] {
  const value = event.payload["external_constraints"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const summary = candidate["summary"];
    if (typeof summary !== "string") return [];
    const constraint: ExternalConstraint = {
      id:
        typeof candidate["id"] === "string"
          ? candidate["id"]
          : stableId("constraint", event.id, index),
      filePath: typeof candidate["filePath"] === "string"
        ? candidate["filePath"]
        : typeof candidate["file_path"] === "string"
          ? candidate["file_path"]
          : "Unknown",
      summary,
      source: typeof candidate["source"] === "string" ? candidate["source"] : "provider_payload"
    };
    const start = candidate["startLine"] ?? candidate["start_line"];
    const end = candidate["endLine"] ?? candidate["end_line"];
    if (typeof start === "number") constraint.startLine = start;
    if (typeof end === "number") constraint.endLine = end;
    if (typeof candidate["excerpt"] === "string") constraint.excerpt = candidate["excerpt"];
    return [constraint];
  });
}

export function inferFiles(diff: string): string[] {
  const paths = diff
    .split("\n")
    .flatMap((line) => (line.startsWith("+++ b/") ? [line.slice(6)] : []))
    .filter((path) => path !== "/dev/null");
  return uniqueSorted(paths);
}

export function inferRanges(files: string[], diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  let currentFile: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    if (!line.startsWith("@@") || !currentFile || !files.includes(currentFile)) continue;
    const match = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = Number(match[2] ?? "1");
    ranges.push({
      file: currentFile,
      start,
      end: Math.max(start, start + count - 1),
      confidence: 0.92,
      label: "Recorded"
    });
  }
  return ranges.length > 0
    ? ranges
    : files.map((file) => ({
        file,
        start: 1,
        end: 999,
        confidence: 0.7,
        label: "Recorded"
      }));
}

function decisions(events: LineageEvent[]): DecisionRecord[] {
  const records: DecisionRecord[] = [];
  let pendingOptions: DecisionOption[] = [];
  let pendingContext = "";
  for (const event of events) {
    if (event.eventType === canonicalEventTypes.assistantOptionsPresented) {
      pendingOptions = payloadOptions(event);
      pendingContext =
        payloadString(event, "decision_context") ??
        payloadString(event, "prompt") ??
        "Agent presented options.";
      continue;
    }
    if (event.eventType === canonicalEventTypes.userDecision) {
      const freeformResponse = payloadString(event, "freeform_response");
      const selectedOptionText = payloadString(event, "selected_option_text");
      const record: DecisionRecord = {
        id: stableId("decision", event.id),
        kind: freeformResponse ? "user_freeform_direction" : "user_selected_option",
        context: payloadString(event, "decision_context") ?? pendingContext,
        alternatives: payloadOptions(event).length > 0 ? payloadOptions(event) : pendingOptions,
        evidence: [event.providerEventName]
      };
      if (freeformResponse) record.freeformResponse = freeformResponse;
      if (selectedOptionText) record.selectedOptionText = selectedOptionText;
      const consequences = payloadString(event, "decision_consequences");
      if (consequences) record.consequences = consequences;
      records.push(record);
      pendingOptions = [];
      pendingContext = "";
      continue;
    }
    if (event.eventType === canonicalEventTypes.permissionDecision) {
      const record: DecisionRecord = {
        id: stableId("decision", event.id),
        kind: "permission_decision",
        context:
          payloadString(event, "decision_context") ??
          payloadString(event, "approval_reason") ??
          "Agent requested permission.",
        alternatives: payloadOptions(event),
        evidence: [event.providerEventName]
      };
      const permissionStatus = payloadString(event, "approval_status");
      const freeformResponse = payloadString(event, "freeform_response");
      const consequences = payloadString(event, "decision_consequences");
      if (permissionStatus) record.permissionStatus = permissionStatus;
      if (freeformResponse) record.freeformResponse = freeformResponse;
      if (consequences) record.consequences = consequences;
      records.push(record);
    }
  }
  return records;
}

function constraints(events: LineageEvent[]): ExternalConstraint[] {
  const all: ExternalConstraint[] = [];
  for (const event of events) {
    all.push(...payloadConstraints(event));
    const tool = payloadString(event, "tool_name");
    if (
      ![canonicalEventTypes.preToolUse, canonicalEventTypes.postToolUse].includes(
        event.eventType as typeof canonicalEventTypes.preToolUse
      ) ||
      !tool ||
      !["Read", "Grep", "Glob"].includes(tool)
    ) {
      continue;
    }
    const input = payloadObject(event, "tool_input");
    const path = input?.["file_path"] ?? input?.["path"] ?? input?.["pattern"];
    if (
      typeof path === "string" &&
      /(spec|adr|requirements|\.md$)/i.test(path)
    ) {
      all.push({
        id: stableId("constraint", event.id, path),
        filePath: path,
        summary: "Provider read this external document during the session.",
        source: "tool_call"
      });
    }
  }
  return [
    ...new Map(
      all.map((constraint) => [
        `${constraint.filePath}|${constraint.startLine ?? ""}|${constraint.summary}|${constraint.source}`,
        constraint
      ])
    ).values()
  ];
}

export interface LinkOptions {
  commitMessage?: (sha: string) => Promise<string | undefined>;
}

export function linkEvents(events: LineageEvent[]): ProvenanceSession[] {
  const grouped = new Map<string, LineageEvent[]>();
  for (const event of events) {
    const key = `${event.provider}\0${event.sessionId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }

  return [...grouped.values()]
    .map((group) => {
      const ordered = [...group].sort(compareEvents);
      const first = ordered[0];
      if (!first) return undefined;
      const stop = [...ordered]
        .reverse()
        .find((event) => event.eventType === canonicalEventTypes.sessionStop);
      const prompt =
        [...ordered]
          .reverse()
          .map((event) => payloadString(event, "prompt"))
          .find(Boolean) ?? "";
      const tools = uniqueSorted(
        ordered.flatMap((event) => {
          const tool = payloadString(event, "tool_name");
          return tool ? [tool] : [];
        })
      );
      const commands = ordered.flatMap((event) => {
        if (payloadString(event, "tool_name") !== "Bash") return [];
        const input = payloadObject(event, "tool_input");
        const command = input?.["command"] ?? input?.["cmd"];
        return typeof command === "string" ? [command] : [];
      });
      const diff = stop ? payloadString(stop, "git_diff") ?? "" : "";
      const files = stop ? payloadStrings(stop, "changed_files") ?? inferFiles(diff) : [];
      const tests =
        (stop && payloadStrings(stop, "tests_detected")) ??
        commands.filter((command) => /(pytest|swift test|xcodebuild test)/.test(command));
      const start = ordered.find((event) => event.eventType === canonicalEventTypes.sessionStart);
      const startHead = start ? payloadString(start, "git_head") : undefined;
      const stopHead = stop ? payloadString(stop, "git_head") : undefined;
      const commitSha = startHead && stopHead && startHead !== stopHead ? stopHead : undefined;
      const displayName = providerDisplayName(first.provider);

      const session: ProvenanceSession = {
        provider: first.provider,
        providerDisplayName: displayName,
        sessionId: first.sessionId,
        source: first.provider,
        actor: displayName,
        humanReviewer: "Unknown",
        prompt,
        toolsUsed: tools,
        commandsRun: commands,
        filesEdited: uniqueSorted(files),
        testsRun: uniqueSorted(tests),
        testsResult: stop ? payloadString(stop, "tests_result") ?? "unknown" : "unknown",
        permissionRequests: ordered.flatMap((event) => {
          const reason = payloadString(event, "approval_reason");
          const status = payloadString(event, "approval_status");
          if (!reason && event.eventType !== canonicalEventTypes.permissionDecision) return [];
          return [`${reason ?? `Permission requested for ${payloadString(event, "tool_name") ?? "tool"}`}${status ? ` (${status})` : ""}`];
        }),
        decisions: decisions(ordered),
        externalConstraints: constraints(ordered),
        lastAssistantMessage: stop ? payloadString(stop, "last_assistant_message") ?? "" : "",
        gitDiff: diff,
        reasoningSummary: prompt
          ? `${displayName} acted on the captured prompt: ${prompt}`
          : `Recorded ${displayName} provenance captured tool usage, edits, tests, and final session evidence.`,
        lineRanges: inferRanges(files, diff)
      };
      const last = [...ordered].reverse();
      const optional: Array<[keyof ProvenanceSession, string | undefined]> = [
        ["turnId", last.map((event) => event.turnId).find(Boolean)],
        ["human", last.map((event) => event.human).find(Boolean)],
        ["model", last.map((event) => event.model).find(Boolean)],
        ["permissionMode", last.map((event) => event.permissionMode).find(Boolean)],
        ["transcriptPath", last.map((event) => event.transcriptPath).find(Boolean)],
        ["commitSha", commitSha]
      ];
      for (const [key, value] of optional) if (value) Object.assign(session, { [key]: value });
      return session;
    })
    .filter((session): session is ProvenanceSession => Boolean(session))
    .sort((left, right) =>
      `${left.provider}\0${left.sessionId}`.localeCompare(`${right.provider}\0${right.sessionId}`)
    );
}

export async function linkRepository(
  store: ProvenanceStore,
  options: LinkOptions = {}
): Promise<ProvenanceSession[]> {
  const sessions = linkEvents(await store.events());
  for (const session of sessions) {
    if (session.commitSha && options.commitMessage) {
      const message = await options.commitMessage(session.commitSha);
      if (message) session.commitMessage = message;
    }
    await store.writeSession(session);
  }
  return sessions;
}
