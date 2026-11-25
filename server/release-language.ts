// The language of a release (#897), from what its source names and from what its title marks. Pure: no database, no
// network, and no import from `src/` (the production image carries only a few of its files).
//
// What the sources carry: AudioBookBay's search results and release pages name a language ("Language: English", read
// from `.postInfo`); Prowlarr's results name none (its release has categories, never a language), so only the title can
// say. A title marks a language by a tag (`[FR]`, `(German)`), by the language's own name (Français, Deutsch, Español,
// Nederlands) or, weakest, by its English name in plain words ("Dungeon Crawler Carl French edition").

import { DEFAULT_SERIES_LANGUAGE } from "../src/series-selection.ts";

type LanguageEntry = {
  code: string;
  /** The name the app shows. */
  name: string;
  /** Spelled out: the language's names, in itself and in English, and the three-letter codes. Lower case, no accents. */
  names: string[];
  /** Two-letter code and others that only a tag in brackets or a field of its own can mean (`[FR]`, never a bare "fr"). */
  tags: string[];
  /** The English name is also an ordinary word of titles ("The Dutch House"): only a title the work itself does not carry counts. */
  weak: boolean;
};

const LANGUAGES: LanguageEntry[] = [
  { code: "en", name: "English", names: ["english", "eng"], tags: ["en", "uk", "us", "gb"], weak: false },
  { code: "fr", name: "French", names: ["french", "francais", "fra", "fre", "version francaise"], tags: ["fr", "vf", "vostfr"], weak: true },
  { code: "de", name: "German", names: ["german", "deutsch", "ger", "deu"], tags: ["de"], weak: true },
  { code: "es", name: "Spanish", names: ["spanish", "espanol", "castellano", "spa"], tags: ["es"], weak: true },
  { code: "it", name: "Italian", names: ["italian", "italiano", "ita"], tags: ["it"], weak: true },
  { code: "nl", name: "Dutch", names: ["dutch", "nederlands", "nld", "dut", "vlaams"], tags: ["nl"], weak: true },
  { code: "pt", name: "Portuguese", names: ["portuguese", "portugues", "por"], tags: ["pt", "br"], weak: true },
  { code: "ru", name: "Russian", names: ["russian", "russkiy", "rus"], tags: ["ru"], weak: true },
  { code: "pl", name: "Polish", names: ["polish", "polski", "pol"], tags: ["pl"], weak: true },
  { code: "sv", name: "Swedish", names: ["swedish", "svenska", "swe"], tags: ["sv", "se"], weak: true },
  { code: "da", name: "Danish", names: ["danish", "dansk", "dan"], tags: ["da", "dk"], weak: true },
  { code: "no", name: "Norwegian", names: ["norwegian", "norsk", "nor"], tags: ["no", "nb"], weak: true },
  { code: "fi", name: "Finnish", names: ["finnish", "suomi", "fin"], tags: ["fi"], weak: true },
  { code: "cs", name: "Czech", names: ["czech", "cestina", "cesky", "ces", "cze"], tags: ["cs", "cz"], weak: true },
  { code: "tr", name: "Turkish", names: ["turkish", "turkce", "tur"], tags: ["tr"], weak: true },
  { code: "ja", name: "Japanese", names: ["japanese", "jpn", "日本語"], tags: ["ja", "jp"], weak: true },
  { code: "zh", name: "Chinese", names: ["chinese", "mandarin", "zho", "chi", "中文"], tags: ["zh", "cn"], weak: true },
  { code: "ko", name: "Korean", names: ["korean", "kor", "한국어"], tags: ["ko", "kr"], weak: true },
];

const plain = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const BY_NAME = new Map<string, LanguageEntry>();
for (const entry of LANGUAGES) {
  BY_NAME.set(entry.code, entry);
  for (const name of entry.names) BY_NAME.set(plain(name), entry);
}
const BY_TAG = new Map<string, LanguageEntry>();
for (const entry of LANGUAGES) {
  BY_TAG.set(entry.code, entry);
  for (const tag of entry.tags) if (!BY_TAG.has(tag)) BY_TAG.set(tag, entry);
}

/** A language as a source or a person writes it ("French", "fra", "fr-CA", "Français") as its two-letter code; any other is its words. */
export function languageCode(language: string | null | undefined): string | null {
  const value = plain(language ?? "");
  if (!value) return null;
  const known = BY_NAME.get(value) ?? BY_NAME.get(value.split(" ")[0]);
  return known?.code ?? value;
}

/** The name of a language's code, as the app shows it ("fr" → "French"); a code of no table is returned as it is. */
export function languageDisplayName(code: string): string {
  return BY_NAME.get(code)?.name ?? code;
}

/** What a source's language field says when it names none ("Unknown", "?", "N/A"): the same as an empty field. */
const NO_LANGUAGE = /^(unknown|unspecified|undetermined|not specified|n a|none|other|multiple|multi|multilingual|multi language|mixed|und|mul|zxx)$/;

/** The languages a source names in one field: "English", "English, French", "English/German". */
export function languagesNamed(field: string | null | undefined): string[] {
  if (NO_LANGUAGE.test(plain(field ?? ""))) return [];
  const codes = (field ?? "")
    .split(/[,/;&|]|\band\b/i)
    .map((part) => languageCode(part))
    .filter((code): code is string => !!code && !NO_LANGUAGE.test(code));
  return [...new Set(codes)];
}

/** Whether a source's language field names the wanted language (a name or a code; English when none is wanted). */
export function namesLanguage(field: string | null | undefined, wanted: string | null | undefined): boolean {
  return languagesNamed(field).includes(languageCode(wanted) ?? DEFAULT_SERIES_LANGUAGE);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The title with the given titles taken out: a language word that is the work's own title is not a mark. */
function withoutTitles(title: string, titles: readonly string[]) {
  let rest = plain(title);
  for (const own of [...titles].map(plain).filter((value) => value.length >= 3).sort((a, b) => b.length - a.length))
    rest = rest.replace(new RegExp(`(^| )${escapeRegExp(own)}(?= |$)`, "g"), "$1 ");
  return rest;
}

/**
 * The languages a release's title marks (two-letter codes): a tag in brackets (`[FR]`, `(German)`), a language's own
 * name (Français, Deutsch, Español, Italiano, Nederlands), `VF`, and an English name in the words ("French", "Dutch")
 * unless it is part of `ownTitles` (the book's and the series' title: "The Dutch House"). `strict` keeps only the marks
 * that cannot be a word of a title: tags in brackets and the languages' own names.
 */
export function titleLanguages(title: string, options: { ownTitles?: readonly string[]; strict?: boolean } = {}): string[] {
  const found = new Set<string>();
  const bracketed = /[\[({]\s*([^\])}]{1,24}?)\s*[\])}]/g;
  for (let match = bracketed.exec(title); match; match = bracketed.exec(title)) {
    for (const part of match[1].split(/[,/;&|+]|\band\b/i)) {
      const word = plain(part);
      const entry = BY_TAG.get(word) ?? BY_NAME.get(word);
      if (entry) found.add(entry.code);
    }
  }
  const rest = withoutTitles(title.replace(bracketed, " "), options.ownTitles ?? []);
  const original = title.replace(bracketed, " ");
  for (const entry of LANGUAGES) {
    for (const name of entry.names) {
      const key = plain(name);
      if (key.length < 4) continue;
      // The language's own name (Français) is a mark wherever it stands; its English name only outside the work's own title.
      const own = key !== plain(entry.name);
      if (options.strict && !own) continue;
      const text = own ? plain(original) : rest;
      if (new RegExp(`(^| )${escapeRegExp(key)}( |$)`).test(text)) found.add(entry.code);
    }
  }
  if (/(^|[^\p{L}\p{N}])VF([^\p{L}\p{N}]|$)/u.test(original) || /\bVOSTFR\b/i.test(original)) found.add("fr");
  return [...found];
}

/** The language a release's title marks, as its name, for a row that says it ("French"); null when it marks none or several. */
export function titleLanguageName(title: string): string | null {
  const found = titleLanguages(title, { strict: true });
  return found.length === 1 ? languageDisplayName(found[0]) : null;
}

export type LanguageVerdict = "fits" | "other" | "unnamed";

/**
 * Whether a release is in the wanted language: "fits" when its source names the language (or, with the source silent,
 * its title marks it), "other" when it names or marks another one, and "unnamed" when nothing says. A language its
 * source names settles it; the title only speaks where the source is silent. Several named languages fit when one of
 * them is the wanted one.
 */
export function releaseLanguageFits(
  release: { title: string; language?: string | null },
  wanted: string | null | undefined,
  ownTitles: readonly string[] = [],
): LanguageVerdict {
  const code = languageCode(wanted) ?? DEFAULT_SERIES_LANGUAGE;
  const named = languagesNamed(release.language);
  if (named.length) return named.includes(code) ? "fits" : "other";
  const marked = titleLanguages(release.title, { ownTitles });
  if (!marked.length) return "unnamed";
  return marked.includes(code) ? "fits" : "other";
}
