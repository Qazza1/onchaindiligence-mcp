/**
 * secEdgar.ts — US public-company verification via SEC EDGAR (free, no API key).
 *
 * SCOPE (important, and stated in the tool description + every result):
 *   EDGAR only covers entities that file with the SEC — i.e. PUBLIC companies,
 *   investment funds, and some debt issuers. It does NOT cover private US
 *   companies, which incorporate at the STATE level (50 separate Secretary of
 *   State registries, no single free API). So a "not found" here means "not an
 *   SEC filer", NOT "not a real company". The result carries a coverage_note so
 *   an agent can't misread that.
 *
 * Data source: SEC EDGAR submissions API (data.sec.gov), public-domain.
 *   SEC requires a descriptive User-Agent with contact info on every request,
 *   and rate-limits to ~10 req/s. We cache the ticker map to avoid refetching
 *   the ~1 MB file on every name/ticker lookup.
 *
 * >>> HOUSE-STYLE NOTE (review when you wake): this mirrors the PUBLIC interface
 *     your server.ts imports from companiesHouse.ts — checkUSCompany(),
 *     buildAttribution(), and USCompanyNotFoundError. If your companiesHouse.ts
 *     shapes attribution differently (field names, nesting), align this to match
 *     so both company tools return a consistent shape. <<<
 *
 * >>> UNVERIFIED: written against the documented EDGAR API but NOT live-tested
 *     (the build sandbox can't reach sec.gov). Test on your machine BEFORE
 *     enabling the paid tool — a broken fetch would charge agents for errors and
 *     hurt your Bazaar fail-rate standing. <<<
 */

import { config } from './config.js'

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'
const SEC_SUBMISSIONS = (cik10: string) =>
  `https://data.sec.gov/submissions/CIK${cik10}.json`

export class USCompanyNotFoundError extends Error {
  constructor(query: string) {
    super(
      `No SEC EDGAR filer found for "${query}". Note: EDGAR covers only ` +
        `SEC-registered (public) companies and funds — not private US ` +
        `companies, which register at the state level and are not in EDGAR.`
    )
    this.name = 'USCompanyNotFoundError'
  }
}

function headers(): Record<string, string> {
  return { 'User-Agent': config.edgar.userAgent, Accept: 'application/json' }
}

/** Zero-pad a CIK (string or number) to the 10-digit form EDGAR's URLs use. */
function pad10(cik: string | number): string {
  return String(cik).replace(/\D/g, '').padStart(10, '0')
}

// --- ticker map cache (6h TTL) -----------------------------------------
type TickerEntry = { cik_str: number; ticker: string; title: string }
let tickerCache: { at: number; entries: TickerEntry[] } | null = null
const TICKER_TTL_MS = 6 * 60 * 60 * 1000

async function getTickerEntries(): Promise<TickerEntry[]> {
  if (tickerCache && Date.now() - tickerCache.at < TICKER_TTL_MS) {
    return tickerCache.entries
  }
  const res = await fetch(SEC_TICKERS_URL, { headers: headers() })
  if (!res.ok) throw new Error(`SEC ticker list fetch failed (${res.status}).`)
  const map = (await res.json()) as Record<string, TickerEntry>
  const entries = Object.values(map)
  tickerCache = { at: Date.now(), entries }
  return entries
}

/**
 * Resolve a user query (CIK | ticker | company name) to a 10-digit CIK.
 * Tries, in order: explicit CIK, exact ticker, exact name, prefix, substring.
 */
async function resolveToCik(query: string): Promise<string> {
  const raw = query.trim()

  // Explicit CIK? e.g. "320193", "0000320193", or "CIK0000320193"
  const stripped = raw.replace(/^cik/i, '').trim()
  if (/^\d{1,10}$/.test(stripped)) return pad10(stripped)

  const entries = await getTickerEntries()
  const q = raw.toUpperCase()

  const hit =
    entries.find((e) => e.ticker.toUpperCase() === q) ||
    entries.find((e) => e.title.toUpperCase() === q) ||
    entries.find((e) => e.title.toUpperCase().startsWith(q)) ||
    entries.find((e) => e.title.toUpperCase().includes(q))

  if (!hit) throw new USCompanyNotFoundError(query)
  return pad10(hit.cik_str)
}

/**
 * Look up a US public company by ticker, CIK, or name. Returns registered
 * identity, industry (SIC), state of incorporation, listing info, business
 * address, and the most recent SEC filing — plus an explicit coverage note.
 */
export async function checkUSCompany(query: string) {
  const cik = await resolveToCik(query)

  const res = await fetch(SEC_SUBMISSIONS(cik), { headers: headers() })
  if (res.status === 404) throw new USCompanyNotFoundError(query)
  if (!res.ok) {
    throw new Error(`SEC EDGAR submissions fetch failed (${res.status}).`)
  }
  const d = (await res.json()) as any

  const recent = d?.filings?.recent
  const latestFiling =
    recent && Array.isArray(recent.form) && recent.form.length
      ? {
          form: recent.form[0] ?? null,
          filing_date: recent.filingDate?.[0] ?? null,
          primary_document: recent.primaryDocument?.[0] ?? null,
        }
      : null

  const addr = d?.addresses?.business || d?.addresses?.mailing || null

  return {
    source: 'SEC EDGAR',
    cik,
    name: d?.name ?? null,
    former_names: Array.isArray(d?.formerNames)
      ? d.formerNames.map((f: any) => f?.name).filter(Boolean)
      : [],
    entity_type: d?.entityType ?? null,
    sic: d?.sic ?? null,
    sic_description: d?.sicDescription ?? null,
    state_of_incorporation: d?.stateOfIncorporation ?? null,
    tickers: Array.isArray(d?.tickers) ? d.tickers : [],
    exchanges: Array.isArray(d?.exchanges) ? d.exchanges : [],
    business_address: addr
      ? {
          street1: addr.street1 ?? null,
          street2: addr.street2 ?? null,
          city: addr.city ?? null,
          state_or_country: addr.stateOrCountry ?? null,
          zip_code: addr.zipCode ?? null,
        }
      : null,
    latest_filing: latestFiling,
    coverage_note:
      'SEC EDGAR covers SEC-registered (public) companies and funds only. ' +
      'A "not found" result does NOT mean the company does not exist — ' +
      'private US companies register at the state level and are not in EDGAR.',
  }
}

/**
 * Source attribution for the result. Mirror companiesHouse.ts buildAttribution()
 * field names/nesting if they differ (see house-style note at top).
 */
export function buildAttribution() {
  return {
    attribution: {
      source: 'U.S. Securities and Exchange Commission (SEC) — EDGAR',
      url: 'https://www.sec.gov/edgar',
      license: 'U.S. government public-domain data',
      retrieved_at: new Date().toISOString(),
    },
  }
}
