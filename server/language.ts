// ISO 639 language tags shared by alignment and ebook-set probing.
// Unknown / undetermined placeholders are treated like a missing language (default eng).

const unknownLanguages = new Set(["und", "mis", "mul", "zxx", "unknown"]);

/** Normalize a language tag to a short ISO 639-1-ish code, or "" when unknown/missing. */
export function language(value: string) {
  const code = value.toLowerCase().split(/[-_]/)[0];
  if (unknownLanguages.has(code)) return "";
  return (
    {
      english: "en",
      french: "fr",
      german: "de",
      spanish: "es",
      italian: "it",
      portuguese: "pt",
      norwegian: "no",
      nob: "no",
      nor: "no",
      eng: "en",
      fra: "fr",
      fre: "fr",
    }[code as "english"] || code
  );
}

/** Map a language tag to ISO 639-3; unknown/missing tags become "eng". */
export function iso3(value: string) {
  return (
    {
      en: "eng",
      fr: "fra",
      de: "deu",
      es: "spa",
      it: "ita",
      pt: "por",
      no: "nob",
      nb: "nob",
      da: "dan",
      sv: "swe",
      nl: "nld",
    }[language(value) as "en"] ||
    language(value) ||
    "eng"
  );
}

/** Two languages conflict only when both are known and differ. */
export function languagesConflict(a?: string | null, b?: string | null) {
  const x = a ? language(a) : "",
    y = b ? language(b) : "";
  return !!x && !!y && x !== y;
}
