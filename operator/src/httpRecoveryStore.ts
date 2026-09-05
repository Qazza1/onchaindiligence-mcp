/**
 * httpRecoveryStore.ts — D2.5A: a CommerceRecoveryStore that runs IN THE
 * BROWSER but never itself holds a secret — every call is a same-origin
 * HTTP round trip to this local operator server's own /local/recovery/*
 * endpoints (operator/server.ts), which are backed by the SDK's own
 * NodeFileRecoveryStore writing to this machine's disk. The browser process
 * never touches localStorage/sessionStorage/IndexedDB for any of this
 * (D2.5's explicit instruction) -- it is exactly a thin RPC client.
 */
import {
  RecoveryRecordExistsError,
  RecoveryRecordNotFoundError,
  VersionConflictError,
  type CommerceRecoveryStore,
  type CommerceRecoveryRecord,
} from '@onchaindiligence/sdk/commerce'

export class HttpRecoveryStore implements CommerceRecoveryStore {
  async create(record: Omit<CommerceRecoveryRecord, 'version' | 'createdAt' | 'updatedAt'>): Promise<CommerceRecoveryRecord> {
    const res = await fetch('/local/recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
    if (res.status === 409) throw new RecoveryRecordExistsError(record.operationId)
    if (!res.ok) throw new Error(`local recovery store create failed: HTTP ${res.status}`)
    return (await res.json()) as CommerceRecoveryRecord
  }

  async load(operationId: string): Promise<CommerceRecoveryRecord | null> {
    const res = await fetch(`/local/recovery/${encodeURIComponent(operationId)}`)
    if (!res.ok) throw new Error(`local recovery store load failed: HTTP ${res.status}`)
    return (await res.json()) as CommerceRecoveryRecord | null
  }

  async update(
    operationId: string,
    patch: Partial<Omit<CommerceRecoveryRecord, 'operationId' | 'version'>>,
    expectedVersion: number
  ): Promise<CommerceRecoveryRecord> {
    const res = await fetch(`/local/recovery/${encodeURIComponent(operationId)}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch, expectedVersion }),
    })
    if (res.status === 404) throw new RecoveryRecordNotFoundError(operationId)
    if (res.status === 409) throw new VersionConflictError(operationId, expectedVersion, -1)
    if (!res.ok) throw new Error(`local recovery store update failed: HTTP ${res.status}`)
    return (await res.json()) as CommerceRecoveryRecord
  }

  async findByClientSubmissionKey(clientSubmissionKey: string): Promise<CommerceRecoveryRecord | null> {
    const res = await fetch(`/local/recovery/by-submission-key/${encodeURIComponent(clientSubmissionKey)}`)
    if (!res.ok) throw new Error(`local recovery store lookup failed: HTTP ${res.status}`)
    return (await res.json()) as CommerceRecoveryRecord | null
  }
}
