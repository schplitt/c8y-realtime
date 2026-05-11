import process from 'node:process'
import type { RealtimeAuth } from '../../src/bayeux/auth'

process.loadEnvFile('.env')

const REQUIRED_ENV = [
  'C8Y_REALTIME_URL',
  'C8Y_REALTIME_TENANT',
  'C8Y_REALTIME_USER',
  'C8Y_REALTIME_PASSWORD',
] as const

export function hasTenantIntegrationEnv(): boolean {
  return REQUIRED_ENV.every((key) => !!process.env[key]?.trim())
}

export function getTenantIntegrationConfig(): { url: string, auth: RealtimeAuth } {
  if (!hasTenantIntegrationEnv()) {
    throw new Error(`Missing required tenant integration env vars: ${REQUIRED_ENV.join(', ')}`)
  }

  return {
    url: process.env.C8Y_REALTIME_URL!,
    auth: {
      type: 'basic',
      tenant: process.env.C8Y_REALTIME_TENANT!,
      user: process.env.C8Y_REALTIME_USER!,
      password: process.env.C8Y_REALTIME_PASSWORD!,
    },
  }
}
