// Public read-only aggregates behind onchaindiligence.com/live. client_name and tool are caller-supplied: never serialized raw.
import type { Hono } from 'hono'
import { loadUsageActivity, type UsageActivityRows } from './db.js'

export const PUBLIC_ACTIVITY_PATH = '/public/activity'
export const ACTIVITY_ALLOWED_ORIGIN = 'https://onchaindiligence.com'
export const DEFAULT_ACTIVITY_WINDOW = '24h'

export const ACTIVITY_WINDOWS = {
  '1h': { interval: '1 hour', stride: '5 minutes' },
  '24h': { interval: '24 hours', stride: '1 hour' },
  '7d': { interval: '7 days', stride: '6 hours' },
} as const
export type ActivityWindow = keyof typeof ACTIVITY_WINDOWS
const WINDOW_KEYS: ReadonlySet<string> = new Set(Object.keys(ACTIVITY_WINDOWS))

export function isActivityWindow(value: unknown): value is ActivityWindow {
  return typeof value === 'string' && WINDOW_KEYS.has(value)
}

export type ClientCategory = 'assistant' | 'directory' | 'discovery' | 'monitoring' | 'other'
export interface ClientClass {
  label: string
  category: ClientCategory
}

export const OTHER_CLIENT: ClientClass = { label: 'Other MCP client', category: 'other' }
const DISCOVERY_PROBE: ClientClass = { label: 'Discovery probe', category: 'discovery' }

// Observed self-reported names only; a match is attribution, not identity.
const KNOWN_CLIENTS: Readonly<Record<string, ClientClass>> = {
  'codex-mcp-client': { label: 'Codex MCP', category: 'assistant' },
  'anthropic/claudeai': { label: 'Claude', category: 'assistant' },
  glama: { label: 'Glama', category: 'directory' },
  mcpdd: { label: 'MCPDD', category: 'directory' },
  'glimind-probe': { label: 'Glimind', category: 'discovery' },
  'guru-hub-probe': { label: 'Guru Hub', category: 'discovery' },
  'rokmcp-probe': { label: 'RokMCP', category: 'discovery' },
  'proofbench-probe': { label: 'ProofBench', category: 'discovery' },
  mcpscoringengine: { label: 'MCP Scoring Engine', category: 'discovery' },
  'x402-observer': { label: 'x402 Observer', category: 'discovery' },
  'mcp-watch': { label: 'MCP Watch', category: 'monitoring' },
  mcpbeat: { label: 'MCPBeat', category: 'monitoring' },
  'brick.blue': { label: 'Brick Blue', category: 'monitoring' },
  'brick-blue-health': { label: 'Brick Blue', category: 'monitoring' },
  'tripwire-archive': { label: 'Tripwire Archive', category: 'monitoring' },
}

export function classifyClient(raw: unknown): ClientClass {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return OTHER_CLIENT
  const key = raw.trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(KNOWN_CLIENTS, key)) return KNOWN_CLIENTS[key]
  if (/^[a-z0-9._-]+-probe$/.test(key)) return DISCOVERY_PROBE
  return OTHER_CLIENT
}

// Tools registered in src/server.ts + src/publicMcp.ts; any other caller-supplied name is dropped.
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'screen_wallet', 'screen_name', 'verify_uk_company', 'verify_us_company', 'diligence',
  'preflight_payment', 'inspect_payment',
  'inspect_allowance', 'preflight_allowance', 'observe_allowance',
  'inspect_swap', 'preflight_swap', 'observe_swap',
  'inspect_bridge', 'preflight_bridge', 'observe_bridge',
  'inspect_staking', 'preflight_staking', 'observe_staking',
  'get_receipt', 'verify_receipt',
])

export function safeToolName(raw: unknown): string | undefined {
  return typeof raw === 'string' && KNOWN_TOOLS.has(raw) ? raw : undefined
}

export type ActivityType =
  | 'client_connected'
  | 'tools_discovered'
  | 'tool_call_attempted'
  | 'tool_completed'
  | 'tool_failed'
  | 'x402_challenge'
  | 'receipt_created'

export interface RecentActivityItem {
  occurred_at: string
  type: ActivityType
  surface: 'public' | 'paid' | 'http'
  label?: string
  tool?: string
}

export interface ActivityResponse {
  generated_at: string
  telemetry_since: string | null
  window: ActivityWindow
  totals: {
    sessions: number
    public_sessions: number
    paid_sessions: number
    tool_calls: number
    successful_tool_calls: number
    failed_tool_calls: number
    x402_challenges: number
    completed_paid_executions: number | null
    receipts: number
  }
  funnel: {
    initialized: number
    tools_listed: number
    tools_called: number
    tool_results_ok: number
    payments_completed: number | null
    receipts_created: number
  }
  clients: Array<{ label: string; category: ClientCategory; sessions: number }>
  timeline: Array<{ bucket: string; sessions: number; tool_calls: number; successful_tool_calls: number; x402_challenges: number }>
  recent_activity: RecentActivityItem[]
  disclosures: {
    not_yet_measured: string[]
    client_identity: string
    x402_challenges: string
  }
}

const DISCLOSURES: ActivityResponse['disclosures'] = {
  not_yet_measured: ['totals.completed_paid_executions', 'funnel.payments_completed'],
  client_identity:
    'Client labels are derived from self-reported MCP clientInfo and are attribution only, not verified identity. Activity includes automated discovery, monitoring, and interactive software.',
  x402_challenges:
    'Counts HTTP 402 payment challenges issued on the x402 HTTP rail. A challenge is not a payment. Payment-required responses on the paid MCP surface are not recorded.',
}

function surfaceOf(value: string | null): RecentActivityItem['surface'] {
  return value === 'public' || value === 'paid' ? value : 'http'
}

function toRecentItem(row: UsageActivityRows['recent'][number]): RecentActivityItem | null {
  const base = { occurred_at: row.occurred_at, surface: surfaceOf(row.surface) }
  const tool = safeToolName(row.tool)
  switch (row.event) {
    case 'mcp.session':
      return { ...base, type: 'client_connected', label: classifyClient(row.client_name).label }
    case 'mcp.request':
      if (row.method === 'tools/list') return { ...base, type: 'tools_discovered' }
      if (row.method === 'tools/call') return { ...base, type: 'tool_call_attempted', ...(tool ? { tool } : {}) }
      return null
    case 'mcp.tool_result':
      if (row.outcome === 'ok') return { ...base, type: 'tool_completed', ...(tool ? { tool } : {}) }
      if (row.outcome === 'error') return { ...base, type: 'tool_failed', ...(tool ? { tool } : {}) }
      return null
    case 'http.request':
      return row.status === '402' ? { ...base, type: 'x402_challenge' } : null
    case 'receipt.created':
      return { ...base, type: 'receipt_created' }
    default:
      return null
  }
}

function aggregateClients(rows: UsageActivityRows): ActivityResponse['clients'] {
  const byLabel = new Map<string, { label: string; category: ClientCategory; sessions: number }>()
  let classified = 0
  for (const row of rows.clients) {
    const cls = classifyClient(row.client_name)
    if (cls === OTHER_CLIENT) continue
    const entry = byLabel.get(cls.label) ?? { label: cls.label, category: cls.category, sessions: 0 }
    entry.sessions += row.sessions
    byLabel.set(cls.label, entry)
    classified += row.sessions
  }
  // Derived from the exact total so "Other" stays correct if the per-name query hits its LIMIT.
  const other = Math.max(0, rows.totals.sessions - classified)
  if (other > 0) byLabel.set(OTHER_CLIENT.label, { ...OTHER_CLIENT, sessions: other })
  return [...byLabel.values()].sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label))
}

export function buildActivityResponse(window: ActivityWindow, rows: UsageActivityRows, now: Date): ActivityResponse {
  const t = rows.totals
  return {
    generated_at: now.toISOString(),
    telemetry_since: rows.telemetrySince,
    window,
    totals: {
      sessions: t.sessions,
      public_sessions: t.public_sessions,
      paid_sessions: t.paid_sessions,
      tool_calls: t.tool_calls,
      successful_tool_calls: t.successful_tool_calls,
      failed_tool_calls: t.failed_tool_calls,
      x402_challenges: t.x402_challenges,
      completed_paid_executions: null,
      receipts: t.receipts,
    },
    funnel: {
      initialized: t.initialized,
      tools_listed: t.tools_listed,
      tools_called: t.tool_calls,
      tool_results_ok: t.successful_tool_calls,
      payments_completed: null,
      receipts_created: t.receipts,
    },
    clients: aggregateClients(rows),
    timeline: rows.timeline.map((b) => ({
      bucket: b.bucket,
      sessions: b.sessions,
      tool_calls: b.tool_calls,
      successful_tool_calls: b.successful_tool_calls,
      x402_challenges: b.x402_challenges,
    })),
    recent_activity: rows.recent.map(toRecentItem).filter((item): item is RecentActivityItem => item !== null),
    disclosures: DISCLOSURES,
  }
}

export interface PublicActivityDependencies {
  load?: (interval: string, stride: string) => Promise<UsageActivityRows>
  now?: () => Date
}

export function mountPublicActivity(app: Hono, deps: PublicActivityDependencies = {}) {
  app.get(PUBLIC_ACTIVITY_PATH, async (c) => {
    // Static, not Origin-echoed: keeps the CDN-cached response identical for every requester.
    c.header('Access-Control-Allow-Origin', ACTIVITY_ALLOWED_ORIGIN)
    const requested = c.req.query('window') ?? DEFAULT_ACTIVITY_WINDOW
    if (!isActivityWindow(requested)) {
      c.header('Cache-Control', 'no-store')
      return c.json({ error: 'invalid window', allowed: Object.keys(ACTIVITY_WINDOWS) }, 400)
    }
    try {
      const { interval, stride } = ACTIVITY_WINDOWS[requested]
      const rows = await (deps.load ?? loadUsageActivity)(interval, stride)
      c.header('Cache-Control', 'public, max-age=0, s-maxage=15, stale-while-revalidate=15')
      return c.json(buildActivityResponse(requested, rows, (deps.now ?? (() => new Date()))()))
    } catch {
      // Never answer a failed read with zeros — that would be fabricated activity.
      c.header('Cache-Control', 'no-store')
      return c.json({ error: 'activity temporarily unavailable' }, 503)
    }
  })
}
