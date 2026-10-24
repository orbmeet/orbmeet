import { describe, it, expect } from 'vitest'
import {
  getPlanLimits,
  PLAN_LIMITS,
} from './plan-limits.ts'

describe('PLAN_LIMITS', () => {
  it('has entries for all 3 plans', () => {
    expect(PLAN_LIMITS).toHaveProperty('free')
    expect(PLAN_LIMITS).toHaveProperty('pro')
    expect(PLAN_LIMITS).toHaveProperty('organization')
  })
})

describe('getPlanLimits', () => {
  it('returns correct free plan limits', () => {
    const limits = getPlanLimits('free')
    expect(limits.maxParticipants).toBe(100)
    expect(limits.maxConcurrentMeetings).toBe(1)
    expect(limits.maxMeetingDurationMinutes).toBe(90)
    expect(limits.maxSpaces).toBe(1)
    expect(limits.maxMembersPerSpace).toBe(25)
    expect(limits.maxWhiteboardsPerSpace).toBe(100)
    expect(limits.maxWhiteboardRestorePointsPerBoard).toBe(25)
    expect(limits.maxStorageBytes).toBe(1 * 1024 * 1024 * 1024)
    expect(limits.recordingEnabled).toBe(false)
    expect(limits.customPersonalMeetingCode).toBe(false)
    expect(limits.pdfExportEnabled).toBe(true)
  })

  it('returns correct pro plan limits', () => {
    const limits = getPlanLimits('pro')
    expect(limits.maxParticipants).toBe(500)
    expect(limits.maxConcurrentMeetings).toBe(5)
    expect(limits.maxMeetingDurationMinutes).toBeNull()
    expect(limits.maxSpaces).toBeNull()
    expect(limits.maxMembersPerSpace).toBe(200)
    expect(limits.maxWhiteboardsPerSpace).toBe(2000)
    expect(limits.maxWhiteboardRestorePointsPerBoard).toBe(250)
    expect(limits.maxStorageBytes).toBe(50 * 1024 * 1024 * 1024)
    expect(limits.recordingEnabled).toBe(true)
    expect(limits.customPersonalMeetingCode).toBe(true)
  })

  it('returns correct organization plan limits', () => {
    const limits = getPlanLimits('organization')
    expect(limits.maxParticipants).toBeNull()
    expect(limits.maxConcurrentMeetings).toBeNull()
    expect(limits.maxMeetingDurationMinutes).toBeNull()
    expect(limits.maxSpaces).toBeNull()
    expect(limits.maxMembersPerSpace).toBeNull()
    expect(limits.maxWhiteboardsPerSpace).toBe(10000)
    expect(limits.maxWhiteboardRestorePointsPerBoard).toBe(1000)
    expect(limits.maxStorageBytes).toBeNull()
    expect(limits.recordingEnabled).toBe(true)
    expect(limits.customPersonalMeetingCode).toBe(true)
  })

  it('free plan has recording disabled', () => {
    expect(getPlanLimits('free').recordingEnabled).toBe(false)
  })

  it('pro and organization plans have recording enabled', () => {
    expect(getPlanLimits('pro').recordingEnabled).toBe(true)
    expect(getPlanLimits('organization').recordingEnabled).toBe(true)
  })

  it('all plans have AI assistant enabled', () => {
    expect(getPlanLimits('free').aiFeaturesEnabled).toBe(true)
    expect(getPlanLimits('pro').aiFeaturesEnabled).toBe(true)
    expect(getPlanLimits('organization').aiFeaturesEnabled).toBe(true)
  })
})
