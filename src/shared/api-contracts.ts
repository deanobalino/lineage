import { Type, type Static } from "@sinclair/typebox";

export const AuthenticatedSessionSchema = Type.Object({
  authenticated: Type.Literal(true),
  csrf: Type.String(),
  expiresAt: Type.Number()
});

export type AuthenticatedSession = Static<typeof AuthenticatedSessionSchema>;

export const AnonymousSessionSchema = Type.Object({
  authenticated: Type.Literal(false)
});

export type AnonymousSession = Static<typeof AnonymousSessionSchema>;

export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
  message: Type.String()
});

export const DiffSideSchema = Type.Union([
  Type.Literal("old"),
  Type.Literal("new")
]);

export type DiffSide = Static<typeof DiffSideSchema>;

export const ProviderSchema = Type.Union([
  Type.Literal("codex"),
  Type.Literal("github-copilot")
]);

export type Provider = Static<typeof ProviderSchema>;

export const ExplainQuerySchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  line: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  base: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  side: Type.Optional(DiffSideSchema),
  previousPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
});

export type ExplainQuery = Static<typeof ExplainQuerySchema>;

export const FollowUpRequestSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  line: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  question: Type.String({ minLength: 1, maxLength: 4_000 }),
  base: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  side: Type.Optional(DiffSideSchema),
  previousPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
});

export type FollowUpRequest = Static<typeof FollowUpRequestSchema>;

export const ExportKindSchema = Type.Union([
  Type.Literal("session-markdown"),
  Type.Literal("session-json"),
  Type.Literal("agent-trace"),
  Type.Literal("explanation")
]);

export type ExportKind = Static<typeof ExportKindSchema>;

export const ExportQuerySchema = Type.Object({
  kind: ExportKindSchema,
  provider: Type.Optional(ProviderSchema),
  session: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  line: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  base: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  side: Type.Optional(DiffSideSchema),
  previousPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }))
});

export type ExportQuery = Static<typeof ExportQuerySchema>;

export const CaptureHealthSchema = Type.Object({
  state: Type.Union([
    Type.Literal("off"),
    Type.Literal("installed"),
    Type.Literal("healthy"),
    Type.Literal("interrupted"),
    Type.Literal("pending"),
    Type.Literal("replaying"),
    Type.Literal("degraded"),
    Type.Literal("restored")
  ]),
  pending: Type.Integer({ minimum: 0 }),
  claimed: Type.Integer({ minimum: 0 }),
  deadLetters: Type.Integer({ minimum: 0 }),
  bytes: Type.Integer({ minimum: 0 }),
  incompleteEvidence: Type.Integer({ minimum: 0 }),
  lastAcknowledgedAt: Type.Optional(Type.String()),
  lastInterruptedAt: Type.Optional(Type.String()),
  lastError: Type.Optional(Type.String())
});

export type CaptureHealthContract = Static<typeof CaptureHealthSchema>;

export const HarnessStatusSchema = Type.Object({
  provider: ProviderSchema,
  configured: Type.Boolean(),
  owned: Type.Boolean(),
  path: Type.String()
});

export type HarnessStatusContract = Static<typeof HarnessStatusSchema>;

export const RepositoryCaptureResponseSchema = Type.Object({
  harnesses: Type.Array(HarnessStatusSchema),
  health: CaptureHealthSchema
});

export type RepositoryCaptureResponse = Static<
  typeof RepositoryCaptureResponseSchema
>;
