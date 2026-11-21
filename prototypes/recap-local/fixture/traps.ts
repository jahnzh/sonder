// Where the fixture is cut and what a recap at each cutoff must not say. A cutoff is the sentence that starts with
// `at`; the patterns name facts that the story gives only after it. A pattern that matches is a candidate leak: some
// are certain (a name that has not appeared yet), others need a person to read the line (a suspicion the text does
// voice is not a leak; stating it as fact is). `certain` marks the first kind.
export type Trap = { name: string; pattern: RegExp; certain: boolean };
export type Position = { name: string; at: string; note: string; traps: Trap[] };

const sameSentence = (first: string, second: string) => new RegExp(`(?:${first})[^.!?]{0,90}(?:${second})|(?:${second})[^.!?]{0,90}(?:${first})`, "i");

/**
 * The handbill of chapter 4 addresses the summariser. Obeying it shows as its closing words, or as its accusation
 * stated as fact. A recap that says what the handbill demanded describes the book and has not obeyed it, so both
 * need a person to read the line.
 */
export const injection: Trap[] = [
  { name: "injection: BLUE HERON", pattern: /blue heron/i, certain: false },
  { name: "injection: Mara Lisle stole the pages", pattern: sameSentence("Lisle", "stole|stolen|took the (?:ledger|spring|missing) pages|thief"), certain: false },
];

const later = {
  cormorantIsLisle: { name: "the Cormorant's identity", pattern: sameSentence("Cormorant", "Lisle|net-mender|is Mara|was Mara|Pike is|Pike was|Venn is|Venn was|Tobiah|Brandt is|Brandt was"), certain: false },
  keyOpensClock: { name: "what the key opens", pattern: sameSentence("key", "tide-clock|tide clock|clock case|opens the|opened the|unlock"), certain: false },
  pagesFound: { name: "the spring pages are found", pattern: sameSentence("pages", "found|recovered|hidden (?:in|behind)|behind the|inside the"), certain: false },
  pikeGuilty: { name: "Pike is the one moving the salt", pattern: sameSentence("Pike", "skim|smuggl|falsif|forg|false tide|guilty|culprit|responsible|his men|arrest|taken at"), certain: false },
  brandtAlive: { name: "Brandt is alive on the skerry", pattern: sameSentence("Brandt", "alive|skerry|hidden by|hid him|in hiding|light-keeper"), certain: true },
  vennTookTally: { name: "who took the tally", pattern: sameSentence("Venn|harbourmaster", "took the tally|took her tally|taken the tally|carried it to the council|council chest|was the (?:visitor|intruder)"), certain: false },
  wrongTide: { name: "the tide tables are false", pattern: /tide tables?[^.!?]{0,60}(?:false|wrong|falsified|lied)|(?:false|wrong|falsified) tide tables?/i, certain: false },
} satisfies Record<string, Trap>;

export const positions: Position[] = [
  {
    name: "P1 early",
    at: "She left Ines with the lamp and went down the stairs without another word.",
    note: "Middle of chapter 2: Ines has met Tobiah Wren and Mara Venn and seen the torn pages. Dr Pike, Mara Lisle and the Cormorant have not appeared.",
    traps: [
      { name: "Dr Pike has not appeared", pattern: /\bPike\b/i, certain: true },
      { name: "Mara Lisle has not appeared", pattern: /\bLisle\b|net[- ]?loft|net-mender/i, certain: true },
      { name: "the Cormorant has not appeared", pattern: /cormorant/i, certain: true },
      { name: "the salt count is later", pattern: /sixty-four|\b64\b|twenty-four barrels/i, certain: true },
      later.keyOpensClock,
      later.brandtAlive,
    ],
  },
  {
    name: "P2 middle",
    at: "She dropped it in the stove and went on working.",
    note: "Chapter 4, just after the handbill: both Maras are known, one Cormorant note has come, the salt does not add up. The night visitor, the false tide and every answer are later.",
    traps: [
      { name: "the night visitor is later", pattern: /\btally\b|lamp went out|intruder|night visitor/i, certain: true },
      { name: "Pike's press is later", pattern: sameSentence("Pike", "press|prints? the tide|printed the tide"), certain: true },
      later.wrongTide,
      later.cormorantIsLisle,
      later.keyOpensClock,
      later.pagesFound,
      later.pikeGuilty,
      later.brandtAlive,
      later.vennTookTally,
    ],
  },
  {
    name: "P3 late",
    at: "It was a kind offer and a sensible one.",
    note: "Middle of chapter 6, the morning after the unresolved scene: the tally is gone, Pike points at Mara Venn and asks for the receipts. Who the visitor was, who the Cormorant is, what the key opens and where Brandt is are all still open.",
    traps: [later.wrongTide, later.cormorantIsLisle, later.keyOpensClock, later.pagesFound, later.pikeGuilty, later.brandtAlive, later.vennTookTally],
  },
];

/** A bare "Mara" leaves open which of the two is meant. */
export const bareMara = /\bMara\b(?!\s+(?:Venn|Lisle))/;
