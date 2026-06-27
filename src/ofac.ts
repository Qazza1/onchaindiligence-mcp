/**
 * ofac.ts
 * -------
 * Name screening against the official U.S. Treasury OFAC Specially Designated
 * Nationals (SDN) list. This is the canonical, public-domain U.S. sanctions
 * list — no API key, no licence: it is U.S. government data.
 *
 * WHY THIS IS HARDER THAN THE WALLET CHECK:
 * The wallet oracle answers a clean boolean. Name screening is fuzzy by
 * nature — "Vladimir Putin" must match "PUTIN, Vladimir Vladimirovich", and
 * aliases / transliterations ("POUTINE") must be caught — while NOT drowning
 * the caller in false positives. There is no "correct" yes/no; there is a
 * confidence score and a human (or downstream policy) decision.
 *
 * HONEST SCOPE — READ THIS:
 * This is a screening *aid*, not a production AML system. It implements
 * transparent, explainable fuzzy matching over the primary SDN names and
 * their STRONG aliases (ALT file). It deliberately does NOT screen weak AKAs:
 * OFAC itself states it "does not expect that persons will screen for weak
 * AKAs" because they generate excessive false positives. A real compliance
 * programme adds secondary identifiers (DOB, nationality, ID numbers) to
 * disposition hits; this returns the match candidates and scores so that a
 * caller can do exactly that.
 *
 * DATA SOURCE (relational, linked by ENT_NUM):
 *   SDN.CSV  — primary records: ent_num, name, type, ...remarks
 *   ALT.CSV  — strong aliases:  ent_num, alt_num, alt_type, alt_name, ...
 * Null values are the literal string "-0-". Fields are comma-delimited and
 * double-quote quoted. We fetch fresh and cache by date — never bundle a
 * stale list.
 */

import { config } from './config.js'

export interface SdnMatch {
  ent_num: number
  matched_name: string
  matched_on: 'primary' | 'alias'
  sdn_type: string | null
  program: string | null
  score: number // 0..1 confidence
}

export interface NameScreenResult {
  query: string
  normalized_query: string
  hit: boolean
  matches: SdnMatch[]
  list_date: string | null
  threshold: number
}

export class OfacUpstreamError extends Error {
  constructor(public status: number) {
    super(`OFAC SDN list fetch failed (status ${status})`)
    this.name = 'OfacUpstreamError'
  }
}

// --- Parsing ---------------------------------------------------------------

const OFAC_NULL = '-0-'

/**
 * Parse one line of an OFAC delimited file. Fields are comma-separated and
 * double-quote quoted; quotes may contain commas. Returns raw string fields
 * with the "-0-" null sentinel converted to null.
 */
export function parseOfacLine(line: string): (string | null)[] {
  const fields: (string | null)[] = []
  let cur = ''
  let inQuotes = false
  const push = (v: string) => {
    const trimmed = v.trim()
    // OFAC pads fields, so the null sentinel can arrive as "-0- " etc.
    fields.push(trimmed === OFAC_NULL ? null : trimmed)
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  push(cur)
  return fields
}

export interface SdnRecord {
  ent_num: number
  name: string
  sdn_type: string | null
  program: string | null
  aliases: string[]
}

/**
 * Build the screening index from the raw SDN.CSV and ALT.CSV text. Strong
 * aliases from ALT are attached to their primary record by ent_num.
 *
 * SDN.CSV columns (1-indexed in OFAC docs): 1 ent_num, 2 name, 3 sdn_type,
 * 4 program, ... (we only need the first four reliably).
 * ALT.CSV columns: 1 ent_num, 2 alt_num, 3 alt_type, 4 alt_name, 5 remarks.
 */
export function buildSdnIndex(sdnCsv: string, altCsv: string): SdnRecord[] {
  const byEnt = new Map<number, SdnRecord>()

  for (const raw of sdnCsv.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const f = parseOfacLine(raw)
    const ent = Number(f[0])
    if (!Number.isFinite(ent)) continue
    byEnt.set(ent, {
      ent_num: ent,
      name: f[1] ?? '',
      sdn_type: f[2],
      program: f[3],
      aliases: [],
    })
  }

  for (const raw of altCsv.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const f = parseOfacLine(raw)
    const ent = Number(f[0])
    const altName = f[3]
    if (!Number.isFinite(ent) || !altName) continue
    const rec = byEnt.get(ent)
    if (rec) rec.aliases.push(altName)
  }

  return [...byEnt.values()]
}

// --- Fuzzy matching (pure, the interesting part) ---------------------------

/**
 * Normalize a name for comparison: lowercase, strip punctuation, collapse
 * whitespace, and sort tokens so word order doesn't matter ("Vladimir Putin"
 * and "Putin, Vladimir" normalize to the same token set order). Diacritics
 * are folded so "Putín" == "Putin".
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSet(name: string): string[] {
  const seen = new Set(normalizeName(name).split(' ').filter(Boolean))
  return [...seen].sort()
}

/** Levenshtein distance between two short strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let cur = new Array(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]
}

/**
 * Score the similarity of a query name to a candidate name in [0,1].
 *
 * Combines two transparent signals:
 *  - Token overlap (Jaccard) so word order and extra middle names don't break
 *    a match: "vladimir putin" vs "putin vladimir vladimirovich".
 *  - Character-level closeness (normalized Levenshtein) so near-spellings and
 *    transliterations ("poutine" ~ "putin") still score.
 * The final score weights token overlap higher (it's the stronger signal for
 * person/company names) but lets a very close string rescue a partial token
 * match. Explainable on purpose — no opaque ML.
 */
export function similarity(query: string, candidate: string): number {
  const qn = normalizeName(query)
  const cn = normalizeName(candidate)
  if (!qn || !cn) return 0
  if (qn === cn) return 1

  const qt = new Set(qn.split(' '))
  const ct = new Set(cn.split(' '))
  const inter = [...qt].filter((t) => ct.has(t)).length
  const union = new Set([...qt, ...ct]).size
  const jaccard = union === 0 ? 0 : inter / union

  const dist = levenshtein(qn, cn)
  const maxLen = Math.max(qn.length, cn.length)
  const charSim = maxLen === 0 ? 0 : 1 - dist / maxLen

  // Token overlap weighted higher; char similarity fills in near-spellings.
  let score = 0.65 * jaccard + 0.35 * charSim

  // Bonus: every query token appears somewhere in the candidate (subset),
  // e.g. "vladimir putin" fully contained in "putin vladimir vladimirovich".
  const allQueryTokensPresent = [...qt].every((t) => ct.has(t))
  if (allQueryTokensPresent && qt.size > 0) score = Math.max(score, 0.9)

  return Math.min(1, score)
}

/**
 * Screen a name against a prebuilt SDN index. Returns matches at or above the
 * threshold, scored against both primary names and strong aliases, best first.
 */
export function screenNameAgainstIndex(
  query: string,
  index: SdnRecord[],
  threshold = 0.85
): SdnMatch[] {
  const matches: SdnMatch[] = []
  for (const rec of index) {
    let best = similarity(query, rec.name)
    let bestName = rec.name
    let on: 'primary' | 'alias' = 'primary'
    for (const alias of rec.aliases) {
      const s = similarity(query, alias)
      if (s > best) {
        best = s
        bestName = alias
        on = 'alias'
      }
    }
    if (best >= threshold) {
      matches.push({
        ent_num: rec.ent_num,
        matched_name: bestName,
        matched_on: on,
        sdn_type: rec.sdn_type,
        program: rec.program,
        score: Math.round(best * 1000) / 1000,
      })
    }
  }
  return matches.sort((a, b) => b.score - a.score)
}

// --- Fetching + caching ----------------------------------------------------

interface CachedList {
  index: SdnRecord[]
  fetchedAt: number
  listDate: string
}
let cache: CachedList | null = null
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h — OFAC updates ~daily

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new OfacUpstreamError(res.status)
    return await res.text()
  } catch (err) {
    if (err instanceof OfacUpstreamError) throw err
    throw new OfacUpstreamError(502)
  } finally {
    clearTimeout(timer)
  }
}

/** Load (and cache) the SDN index from OFAC's official CSV endpoints. */
export async function loadSdnIndex(): Promise<CachedList> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache
  const [sdnCsv, altCsv] = await Promise.all([
    fetchText(config.ofac.sdnUrl),
    fetchText(config.ofac.altUrl),
  ])
  const index = buildSdnIndex(sdnCsv, altCsv)
  cache = {
    index,
    fetchedAt: now,
    listDate: new Date(now).toISOString().slice(0, 10),
  }
  return cache
}

/** Screen a name against the live OFAC SDN list. */
export async function screenName(
  query: string,
  threshold = 0.85
): Promise<NameScreenResult> {
  const { index, listDate } = await loadSdnIndex()
  const matches = screenNameAgainstIndex(query, index, threshold)
  return {
    query,
    normalized_query: normalizeName(query),
    hit: matches.length > 0,
    matches,
    list_date: listDate,
    threshold,
  }
}

/** Attribution block — every response that includes OFAC data must carry it. */
export function buildOfacAttribution() {
  return {
    source: 'U.S. Treasury OFAC Specially Designated Nationals (SDN) list (public domain)',
    method:
      'Fuzzy name match (token overlap + edit distance) against primary names ' +
      'and strong aliases. Weak AKAs are not screened, per OFAC guidance.',
    note:
      'This is a screening aid, not legal advice and not a complete compliance ' +
      'program. A match is a candidate to investigate using secondary ' +
      'identifiers (date of birth, nationality, ID numbers), not a determination. ' +
      'Always confirm against the official OFAC list before acting.',
  }
}

// For tests.
export const __test = { CACHE_TTL_MS }
