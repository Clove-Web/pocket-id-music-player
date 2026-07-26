// Normalisation + lightweight fuzzy matching for duplicate detection and
// artist search. Deliberately dependency-free (no pg_trgm, no npm fuzzy-match
// lib) so it works on any Postgres role without extension privileges and
// doesn't add install weight — see the note on gen_random_uuid() in
// schema.sql for why this codebase avoids extensions.

// Suffixes that don't change what the recording *is* — safe to strip before
// comparing titles. Deliberately conservative: things like "Live", "Remix",
// "Acoustic", "Demo" are NOT in this list because they usually mean a
// materially different recording.
const NOISE_SUFFIXES = [
    "official audio",
    "official video",
    "official music video",
    "lyric video",
    "lyrics",
    "audio",
    "video",
    "remastered",
    "remaster",
    "radio edit",
    "clean",
    "explicit",
    "hd",
    "hq",
];

const noiseSuffixPattern = new RegExp(
    `\\s*[\\(\\[][^)\\]]*\\b(${NOISE_SUFFIXES.map((s) => s.replace(/ /g, "\\s+")).join("|")})\\b[^)\\]]*[\\)\\]]\\s*`,
    "gi",
);

// Loose normalisation: lowercase, strip noise suffixes + punctuation,
// collapse whitespace. Keeps spaces so "1 800" and "1800" both become
// distinguishable-but-similar strings for the dice-coefficient comparison.
export function normalizeTitle(raw: string): string {
    return raw
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "") // strip accents
        .toLowerCase()
        .replace(noiseSuffixPattern, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

// Tight key: normalizeTitle with spaces removed too, so "1-800", "1 800" and
// "1800" all collapse to the same key for an exact-match fast path.
export function tightTitleKey(raw: string): string {
    return normalizeTitle(raw).replace(/\s+/g, "");
}

export function normalizeArtistName(raw: string): string {
    return raw
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

// Splits a raw artist credit into individual artist names, e.g.
// "bbno$ & Ironmouse" -> ["bbno$", "Ironmouse"], "A feat. B, C" -> ["A","B","C"].
// Word-bounded keywords require whitespace on both sides (not \b — that plays
// badly with an optional trailing "." in "feat."/"ft."/"vs."), so a name that
// merely contains "x" (e.g. "Rex") isn't split.
const ARTIST_SEPARATOR =
    /\s*(?:,|&|\+|\/)\s*|\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+/gi;

export function splitArtistNames(raw: string): string[] {
    return raw
        .split(ARTIST_SEPARATOR)
        .map((s) => s.trim())
        .filter(Boolean);
}

// Sørensen–Dice coefficient over character bigrams. 0 = no similarity,
// 1 = identical. Cheap, dependency-free, and good enough for short strings
// like song titles and artist names.
export function diceCoefficient(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const bigrams = (s: string): Map<string, number> => {
        const map = new Map<string, number>();
        for (let i = 0; i < s.length - 1; i++) {
            const gram = s.slice(i, i + 2);
            map.set(gram, (map.get(gram) ?? 0) + 1);
        }
        return map;
    };

    const aGrams = bigrams(a);
    const bGrams = bigrams(b);
    let intersection = 0;
    for (const [gram, count] of aGrams) {
        const other = bGrams.get(gram);
        if (other) intersection += Math.min(count, other);
    }

    const total = [...aGrams.values()].reduce((s, n) => s + n, 0) +
        [...bGrams.values()].reduce((s, n) => s + n, 0);
    return total === 0 ? 0 : (2 * intersection) / total;
}

// Similarity between two raw (un-normalised) titles, 0..1. Exact tight-key
// matches ("1-800" vs "1800") short-circuit to 1.
export function titleSimilarity(a: string, b: string): number {
    if (tightTitleKey(a) === tightTitleKey(b)) return 1;
    return diceCoefficient(normalizeTitle(a), normalizeTitle(b));
}

// Whether two raw artist credits share at least one artist in common,
// e.g. "bbno$" overlaps with "bbno$ & Ironmouse" via the primary artist.
export function artistsOverlap(a: string, b: string): boolean {
    const aNames = new Set(splitArtistNames(a).map(normalizeArtistName));
    const bNames = new Set(splitArtistNames(b).map(normalizeArtistName));
    for (const name of aNames) {
        if (bNames.has(name)) return true;
    }
    return false;
}