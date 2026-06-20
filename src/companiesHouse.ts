/**
 * companiesHouse.ts
 * -----------------
 * Thin client for the UK Companies House public API.
 *
 * Licensing note: this is UK government open data. Companies House
 * explicitly permits commercial use with no licensing fee and no
 * resale restriction — this is meaningfully different from the
 * Chainalysis situation, and there's no AUP gymnastics required here.
 * The only real constraint is operational, not legal: it's a free
 * government service with no SLA, so build for occasional slowness
 * or downtime, not for guaranteed uptime.
 *
 * Auth: Companies House uses HTTP Basic Auth with the API key as the
 * username and an empty password — not a header like Chainalysis.
 */

import { config } from './config.js'

export interface CompanyProfile {
  companyNumber: string
  companyName: string
  status: string // e.g. "active", "dissolved", "liquidation"
  type: string
  incorporatedOn?: string
  registeredAddress?: string
}

export interface PscEntry {
  name: string
  kind: string // e.g. "individual-person-with-significant-control"
  natureOfControl: string[]
  notifiedOn?: string
}

export interface CompanyCheckResult {
  profile: CompanyProfile
  pscList: PscEntry[]
  pscListTruncated: boolean
}

export class CompanyNotFoundError extends Error {
  constructor(companyNumber: string) {
    super(`No company found for number "${companyNumber}"`)
    this.name = 'CompanyNotFoundError'
  }
}

export class CompaniesHouseUpstreamError extends Error {
  constructor(public status: number) {
    super(`Companies House API returned an unexpected status: ${status}`)
    this.name = 'CompaniesHouseUpstreamError'
  }
}

function authHeader(): string {
  // Basic auth: "apikey:" (empty password), base64-encoded.
  return 'Basic ' + Buffer.from(`${config.companiesHouse.apiKey}:`).toString('base64')
}

async function fetchProfile(companyNumber: string): Promise<CompanyProfile> {
  const url = `${config.companiesHouse.baseUrl}/company/${encodeURIComponent(companyNumber)}`
  const response = await fetch(url, { headers: { Authorization: authHeader() } })

  if (response.status === 404) {
    throw new CompanyNotFoundError(companyNumber)
  }
  if (!response.ok) {
    throw new CompaniesHouseUpstreamError(response.status)
  }

  const data = (await response.json()) as any
  const addr = data.registered_office_address
  const registeredAddress = addr
    ? [addr.address_line_1, addr.locality, addr.postal_code].filter(Boolean).join(', ')
    : undefined

  return {
    companyNumber: data.company_number,
    companyName: data.company_name,
    status: data.company_status,
    type: data.type,
    incorporatedOn: data.date_of_creation,
    registeredAddress,
  }
}

async function fetchPsc(companyNumber: string): Promise<{ list: PscEntry[]; truncated: boolean }> {
  const url = `${config.companiesHouse.baseUrl}/company/${encodeURIComponent(companyNumber)}/persons-with-significant-control`
  const response = await fetch(url, { headers: { Authorization: authHeader() } })

  // A 404 here commonly means "this company has no PSC records" (e.g.
  // very small or very new companies) rather than an error — treat it
  // as an empty list, not a failure.
  if (response.status === 404) {
    return { list: [], truncated: false }
  }
  if (!response.ok) {
    throw new CompaniesHouseUpstreamError(response.status)
  }

  const data = (await response.json()) as any
  const items = data.items ?? []

  const list: PscEntry[] = items.map((item: any) => ({
    name: item.name ?? 'Unnamed (corporate or legal entity)',
    kind: item.kind,
    natureOfControl: item.natural_of_control ?? item.natures_of_control ?? [],
    notifiedOn: item.notified_on,
  }))

  // Companies House paginates; total_results vs items.length tells us
  // if we're seeing everything or just a first page.
  const truncated = typeof data.total_results === 'number' && data.total_results > items.length

  return { list, truncated }
}

/**
 * Fetches company profile + PSC (persons with significant control) data
 * in parallel. PSC is the part that matters most for actual KYB/AML use —
 * it answers "who really controls this company," not just "is it
 * registered."
 */
export async function checkCompany(companyNumber: string): Promise<CompanyCheckResult> {
  const [profile, psc] = await Promise.all([
    fetchProfile(companyNumber),
    fetchPsc(companyNumber),
  ])

  return {
    profile,
    pscList: psc.list,
    pscListTruncated: psc.truncated,
  }
}

export function buildAttribution() {
  return {
    source: 'UK Companies House (open government data, free for commercial use)',
    note: 'Live lookup, not cached. No SLA — Companies House is a free government service.',
  }
}
