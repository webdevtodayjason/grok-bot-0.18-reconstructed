/**
 * JEV-2. The question sets, copied verbatim from `scripts/jev-eval.mjs`.
 *
 * The wording is the artefact: it was tuned against `tests/fixtures/jev-cases.json` and then
 * measured against a blind held-out set that nobody tuned against. Rewording a single clause here
 * silently invalidates both measurements, so these strings are copied, never edited, and a test
 * pins them against the harness so a well-meaning tidy-up fails the suite instead of the model.
 *
 * Only judgments 1 and 3 are here. Judgment 2 is held (the page-fetch rung failed the blind set)
 * and 2b is not wired, so neither is copied: an unused question set is a question set that drifts.
 */

export interface JevChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

/** Request interpretation. State is `{request, workspace_location?}`. */
export const JUDGMENT_1_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  scope: {
    type: "choice",
    instructions: "What does the person want to know about where to get this item?",
    criteria: {
      local_in_store:
        "which physical stores near a named or implied place have it on the shelf or for pickup today",
      online_ship: "where it can be ordered online and shipped, place does not matter",
      national_price: "what it costs in general, comparing prices, no store or place named",
      informational: "what the item is, how it works, or advice, not where to buy",
      unclear: "the request does not say enough to tell",
    },
  },
  // The four constraint nouls name `request` by path. The state also carries `workspace_location`,
  // which scope still needs as the implied place, but which is where the person is sitting and not
  // something they asked for. Without the path, every one of these reads the whole state.
  names_stores: {
    type: "noul",
    instructions:
      "Does `request` name one or more specific retailers or store chains by name? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "at least one retailer or chain is named in `request`, such as Home Depot or Ace",
      false: "`request` names no retailer or chain",
    },
  },
  names_location: {
    type: "noul",
    instructions:
      "Does `request` name a city, town, ZIP code, neighbourhood, or say 'near me' or 'local'? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "`request` names a city, town, ZIP code or neighbourhood, or says near me or local",
      false: "`request` names no place and does not say near me or local",
    },
  },
  names_quantity: {
    type: "noul",
    instructions:
      "Does `request` state a required quantity, pack size, or count per package? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "`request` states a number of units or a pack size, such as packs of 10",
      false: "`request` states no quantity or pack size",
    },
  },
  substitutes_ok: {
    type: "noul",
    instructions:
      "Does `request` allow a different size, finish, or pack than the one stated? Judge only the text in `request`, not the `workspace_location` field.",
    criteria: {
      true: "the person says a substitute, similar item, or any size is fine",
      false: "`request` asks for the exact item as stated, or says nothing about substitutes",
    },
  },
};

/** Claim check. State is `{claim, evidence, sources_checked, sources_named_in_request}`. */
export const JUDGMENT_3_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  support: {
    type: "choice",
    instructions: "How does the evidence relate to the claim?",
    criteria: {
      supports: "the evidence states the claim or directly implies it",
      contradicts: "the evidence states the opposite or shows a case the claim rules out",
      no_evidence: "the evidence does not speak to the claim either way",
    },
  },
  is_universal_negative: {
    type: "noul",
    instructions:
      "Does the claim say that no store, nobody, or no source at all has the item, rather than that the checked sources did not show it?",
    criteria: {
      true: "the claim is about everyone or everywhere",
      false: "the claim is scoped to the sources named as checked, or is not a negative",
    },
  },
};
