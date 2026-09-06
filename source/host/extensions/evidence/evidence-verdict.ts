// Claim provenance, rule "containment@1". Zero runtime imports on purpose: the unit test loads this
// file alone through an esbuild transform, the same way the transport test does.
//
// A message's evidence-bearing tokens are the parts of it a tool would have produced: file names
// with a known extension, multi-segment paths, URLs, long hex strings, long numbers. Tokens the user
// already said in the prompt are not claims. The verdict is decided only from this attempt's
// attestation heads; nothing here reads the model's prose to decide what the tools did.
// ponytail: literal containment, versioned; swap the rule, keep the records.
export const EVIDENCE_CHECKER = "containment@1";

export type EvidenceVerdict = "conversational" | "unverified" | "unsupported" | "evidenced" | "undecidable";

export interface AttestationLike {
  readonly head: string;
  readonly truncated: boolean;
}

export interface VerdictResult {
  readonly verdict: EvidenceVerdict;
  readonly missing: readonly string[];
  readonly tokens: readonly string[];
}

const FILE_EXTENSIONS = "txt|md|json|js|mjs|cjs|ts|tsx|jsx|py|log|csv|yaml|yml|toml|html|css|sh|pdf|png|jpg|jpeg|gif|svg|zip|tar|gz|sql|xml|env|lock|ini|conf";
const TOKEN_PATTERN = new RegExp(
  `https?://[^\\s)\\]"']+|(?:/[\\w.\\-]+){2,}|\\b[\\w\\-]+\\.(?:${FILE_EXTENSIONS})\\b|\\b[0-9a-f]{12,}\\b|\\b\\d{5,}\\b`,
  "gi",
);

// A token the model wrote as a shape rather than a value: "captions/NNN.vtt?expires=...&sig=...",
// "<id>", "{slug}", "****". Scribe described what a caption URL looks like and the rule read it
// as a URL it never fetched (2026-09-05, attempt 9c096226). A shape is not a claim; the real
// URLs, had it quoted one, would still have to be in a head. Rule name unchanged, as with the
// version-and-year exclusion: the check is the same, the input is cleaner.
const PLACEHOLDER = /\.{3}|…|\bN{3,}\b|\bX{3,}\b|<[^>]*>|\{[^}]*\}|\*{3,}|\[redacted/i;

export function evidenceTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of String(text ?? "").matchAll(TOKEN_PATTERN)) if (!PLACEHOLDER.test(match[0])) seen.add(match[0]);
  return [...seen];
}

export function decideVerdict(text: string, prompt: string, attestations: readonly AttestationLike[]): VerdictResult {
  const given = new Set(evidenceTokens(prompt));
  const tokens = evidenceTokens(text).filter((token) => !given.has(token));
  if (tokens.length === 0) return { verdict: "conversational", missing: [], tokens };
  if (attestations.length === 0) return { verdict: "unverified", missing: tokens, tokens };
  const missing = tokens.filter((token) => !attestations.some((attestation) => attestation.head.includes(token)));
  if (missing.length === 0) return { verdict: "evidenced", missing, tokens };
  return { verdict: attestations.some((attestation) => attestation.truncated) ? "undecidable" : "unsupported", missing, tokens };
}
