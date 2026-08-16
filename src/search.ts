// lazer 搜索语法移植：osu.Game/Screens/Select/FilterQueryParser.cs +
// FilterCriteria.cs。支持 `star>7`、`ar=9`、`creator=xxx`、`"精确"[!]`、
// `[难度名]`、数值区间 `star=5-6`、状态集合 `status=ranked|loved` 等表达式；
// 不构成表达式的词退回普通子串搜索。

export interface Beatmap {
  sha256: string;
  md5: string;
  online_id: number;
  star_rating: number;
  ruleset: string;
  name: string;
  ar: number;
  dr: number;
  cs: number;
  od: number;
  bpm: number;
  length_ms: number;
  status: number;
  last_played: string;
  divisor: number;
  source: string;
  tags: string;
}

export interface BeatmapSetLike {
  artist: string;
  artist_unicode: string;
  title: string;
  title_unicode: string;
  creator: string;
  online_id: number;
  date_added: string;
  beatmaps: Beatmap[];
}

type Op = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

interface NumRange {
  min?: number;
  max?: number;
  minInclusive: boolean;
  maxInclusive: boolean;
}

interface TextFilter {
  term: string;
  negated: boolean;
}

interface SearchTerm {
  term: string;
  exact: boolean;
}

export interface Criteria {
  ranges: Partial<Record<string, NumRange>>;
  status?: { values: Set<number>; negated: boolean };
  mode?: { value: string; negated: boolean };
  texts: TextFilter[];
  tags: TextFilter[];
  diffNames: TextFilter[];
  terms: SearchTerm[];
}

const QUERY_SYNTAX = /\b(\w+)(!?(:|=)|(>|<)(:|=)?)((".*?"[!]?)|(\S*))/gi;

const STATUS_MAP: Record<string, number> = {
  any: -3,
  unknown: -3,
  none: -3,
  locallymodified: -4,
  graveyard: -2,
  grave: -2,
  wip: -1,
  pending: 0,
  ranked: 1,
  approved: 2,
  qualified: 3,
  loved: 4,
  favourite: 4,
  favorite: 4,
};

const MODE_ALIASES: Record<string, string> = {
  osu: "osu",
  standard: "osu",
  catch: "fruits",
  fruits: "fruits",
  ctb: "fruits",
  taiko: "taiko",
  mania: "mania",
};

/** 数值键的取值与精度（lazer TryUpdateCriteriaRange 的 precision 参数）。 */
const NUMERIC_KEYS: Record<string, { get: (b: Beatmap) => number; precision: number }> = {
  star: { get: (b) => b.star_rating, precision: 0.5 },
  stars: { get: (b) => b.star_rating, precision: 0.5 },
  sr: { get: (b) => b.star_rating, precision: 0.5 },
  ar: { get: (b) => b.ar, precision: 0.05 },
  dr: { get: (b) => b.dr, precision: 0.05 },
  hp: { get: (b) => b.dr, precision: 0.05 },
  cs: { get: (b) => b.cs, precision: 0.05 },
  od: { get: (b) => b.od, precision: 0.05 },
  bpm: { get: (b) => b.bpm, precision: 0.5 },
  length: { get: (b) => b.length_ms / 1000, precision: 1 },
  divisor: { get: (b) => b.divisor, precision: 1 },
};

/** 解析 lazer 语法的查询串，返回结构化条件。 */
export function parseQuery(query: string): Criteria {
  const criteria: Criteria = {
    ranges: {},
    texts: [],
    tags: [],
    diffNames: [],
    terms: [],
  };
  let remaining = query;
  for (const match of query.matchAll(QUERY_SYNTAX)) {
    const [token, key, , , , , valueRaw] = match;
    const op = parseOperator(token.slice(key.length, token.length - valueRaw.length));
    const value = valueRaw.replace(/^"|"$/g, "").replace(/[!]$/, "");
    const lowerKey = key.toLowerCase();
    if (applyKeyword(criteria, lowerKey, op, value)) {
      remaining = remaining.replace(token, "");
    }
  }
  // [难度名] 段 → 难度名条件（子串匹配，lazer SearchText 同款）。
  for (const match of remaining.matchAll(/\[(.*?)(\]\s|$)/g)) {
    const name = match[1].replace(/\]+$/, "").trim();
    if (name) criteria.diffNames.push({ term: name.toLowerCase(), negated: false });
    remaining = remaining.replace(match[0], " ");
  }
  criteria.terms = parseSearchText(remaining);
  return criteria;
}

function parseOperator(op: string): Op {
  switch (op.toLowerCase()) {
    case ":":
    case "=":
      return "eq";
    case "!:":
    case "!=":
      return "ne";
    case "<":
      return "lt";
    case "<:":
    case "<=":
      return "le";
    case ">":
      return "gt";
    case ">:":
    case ">=":
      return "ge";
    default:
      return "eq";
  }
}

function applyKeyword(criteria: Criteria, key: string, op: Op, value: string): boolean {
  const numeric = NUMERIC_KEYS[key];
  if (numeric) {
    return updateRange(criteria, key, op, value, numeric.precision);
  }
  switch (key) {
    case "status":
      return updateStatus(criteria, op, value);
    case "mode":
    case "ruleset": {
      const mode = MODE_ALIASES[value.toLowerCase()];
      if (!mode) return false;
      criteria.mode = { value: mode, negated: op === "ne" };
      return true;
    }
    case "creator":
    case "author":
    case "mapper":
      return updateText(criteria.texts, () => true, op, value);
    case "artist":
    case "title":
    case "source":
      return updateText(criteria.texts, () => true, op, value);
    case "diff":
      return updateText(criteria.diffNames, () => true, op, value);
    case "tag":
      return updateText(criteria.tags, () => true, op, value);
    default:
      return false;
  }
}

/** 数值条件（lazer TryUpdateCriteriaRange）：`=` 支持 `a-b` 区间，值按精度取整。
 * length 键支持 lazer 的时长后缀（如 `2m`、`1m30s`、`90s`）。 */
function updateRange(
  criteria: Criteria,
  key: string,
  op: Op,
  value: string,
  precision: number,
): boolean {
  const range = (criteria.ranges[key] ??= {
    minInclusive: true,
    maxInclusive: true,
  });
  if (op === "ne") {
    return false;
  }
  const parse = (text: string) =>
    key === "length" ? parseLengthValue(text) : parseFloat(text);
  if (op === "eq") {
    const [minText, maxText] = value.split("-", 2);
    const min = parse(minText);
    if (Number.isNaN(min)) return false;
    const max = maxText !== undefined ? parse(maxText) : min;
    if (Number.isNaN(max)) return false;
    range.min = roundTo(min, precision);
    range.max = roundTo(max, precision);
    range.minInclusive = true;
    range.maxInclusive = true;
  } else if (op === "lt" || op === "le") {
    const max = parse(value);
    if (Number.isNaN(max)) return false;
    range.max = roundTo(max, precision);
    range.maxInclusive = op === "le";
  } else {
    const min = parse(value);
    if (Number.isNaN(min)) return false;
    range.min = roundTo(min, precision);
    range.minInclusive = op === "ge";
  }
  return true;
}

/** lazer tryUpdateLengthRange 的时长解析：`90`/`90s`/`2m`/`1m30s`/`1h` → 秒。 */
function parseLengthValue(text: string): number {
  const trimmed = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  let seconds = 0;
  let matched = false;
  for (const part of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const amount = parseFloat(part[1]);
    const unit = part[2];
    seconds += unit === "ms" ? amount / 1000 : unit === "s" ? amount : unit === "m" ? amount * 60 : amount * 3600;
    matched = true;
  }
  return matched ? seconds : NaN;
}

function updateStatus(criteria: Criteria, op: Op, value: string): boolean {
  const values = new Set<number>();
  for (const part of value.toLowerCase().split("|")) {
    const mapped = STATUS_MAP[part.trim()];
    if (mapped === undefined) return false;
    values.add(mapped);
  }
  criteria.status = { values, negated: op === "ne" };
  return true;
}

function updateText(
  list: TextFilter[],
  _unused: () => boolean,
  op: Op,
  value: string,
): boolean {
  if (!value) return false;
  list.push({ term: value.toLowerCase(), negated: op === "ne" });
  return true;
}

/** 剩余文本拆词（lazer SearchText）：`"精确"[!]`、空格分词。 */
function parseSearchText(text: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  let remaining = text.trim();
  for (const match of remaining.matchAll(/("[^"]+"[!]?)/g)) {
    terms.push({ term: match[0].replace(/^"|"$/g, "").replace(/[!]$/, "").toLowerCase(), exact: match[0].endsWith("!") });
    remaining = remaining.replace(match[0], " ");
  }
  for (const word of remaining.split(/\s+/)) {
    if (word) terms.push({ term: word.toLowerCase(), exact: false });
  }
  return terms;
}

function roundTo(value: number, precision: number): number {
  return Math.round(value / precision) * precision;
}

// ---- 匹配 ----

function contains(field: string, term: string): boolean {
  return field.toLowerCase().includes(term);
}

function rangeOk(range: NumRange, value: number, precision: number): boolean {
  const rounded = roundTo(value, precision);
  if (range.min !== undefined) {
    if (rounded < range.min || (!range.minInclusive && rounded === range.min)) return false;
  }
  if (range.max !== undefined) {
    if (rounded > range.max || (!range.maxInclusive && rounded === range.max)) return false;
  }
  return true;
}

/** 集合层面的可搜索文本（罗马字 + Unicode 都参与，支持 Unicode 搜索）。 */
function setSearchableText(set: BeatmapSetLike): string {
  return [
    set.artist,
    set.artist_unicode,
    set.title,
    set.title_unicode,
    set.creator,
    ...set.beatmaps.map((b) => `${b.name} ${b.source} ${b.tags}`),
  ]
    .join("\n")
    .toLowerCase();
}

function beatmapMatches(beatmap: Beatmap, criteria: Criteria): boolean {
  for (const [key, range] of Object.entries(criteria.ranges)) {
    if (!range) continue;
    const numeric = NUMERIC_KEYS[key];
    if (numeric && !rangeOk(range, numeric.get(beatmap), numeric.precision)) {
      return false;
    }
  }
  if (
    criteria.mode &&
    (beatmap.ruleset === criteria.mode.value) === criteria.mode.negated
  ) {
    return false;
  }
  if (criteria.status) {
    const inSet = criteria.status.values.has(beatmap.status);
    if (inSet === criteria.status.negated) return false;
  }
  for (const filter of criteria.diffNames) {
    const hit = contains(beatmap.name, filter.term);
    if (hit === filter.negated) return false;
  }
  for (const filter of criteria.tags) {
    const hit = contains(beatmap.tags, filter.term);
    if (hit === filter.negated) return false;
  }
  return true;
}

/** 谱面集匹配：难度级条件需至少一张难度满足，文本条件作用于谱面集元数据。 */
export function setMatches(set: BeatmapSetLike, criteria: Criteria): boolean {
  if (
    criteria.ranges.star ||
    criteria.ranges.stars ||
    criteria.ranges.sr ||
    criteria.ranges.ar ||
    criteria.ranges.dr ||
    criteria.ranges.hp ||
    criteria.ranges.cs ||
    criteria.ranges.od ||
    criteria.ranges.bpm ||
    criteria.ranges.length ||
    criteria.ranges.divisor ||
    criteria.mode ||
    criteria.status ||
    criteria.diffNames.length ||
    criteria.tags.length
  ) {
    if (!set.beatmaps.some((b) => beatmapMatches(b, criteria))) return false;
  }
  for (const filter of criteria.texts) {
    // creator/artist/title/source 都是集合级元数据；source/tag 也可能在难度上。
    const field = `${set.artist} ${set.artist_unicode} ${set.title} ${set.title_unicode} ${set.creator} ${set.beatmaps
      .map((b) => `${b.source} ${b.tags}`)
      .join(" ")}`;
    const hit = contains(field, filter.term);
    if (hit === filter.negated) return false;
  }
  if (criteria.terms.length) {
    const searchable = setSearchableText(set);
    for (const term of criteria.terms) {
      const hit = term.exact
        ? searchable
            .split("\n")
            .some((field) => field.trim() === term.term)
        : searchable.includes(term.term);
      if (!hit) return false;
    }
  }
  return true;
}

/** 简单关键词搜索（皮肤/回放分类用）：全部子串命中才算匹配。 */
export function simpleMatch(texts: string[], query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts.join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}
