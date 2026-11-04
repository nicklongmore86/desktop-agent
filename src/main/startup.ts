import { app } from 'electron'
import { claimInstance } from './instance-lock'

/**
 * Imported first by index.ts: modules run in import order, so a second copy of the app ends
 * here, before any other module of the app has loaded (see claimInstance).
 */
export const ownsInstance = claimInstance(app)
