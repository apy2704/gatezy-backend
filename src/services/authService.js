// src/services/authService.js
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const db = require('../utils/db')
const logger = require('../utils/logger')

/**
 * Custom authentication error with HTTP status code
 */
class AuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = statusCode
  }
}

/**
 * Hash a 4-digit PIN using bcrypt
 * @param {string|number} pin
 * @returns {Promise<string>}
 */
const hashPin = async (pin) => {
  const saltRounds = 10
  return await bcrypt.hash(String(pin), saltRounds)
}

/**
 * Verify a plain PIN against a bcrypt hash
 * @param {string|number} pin
 * @param {string} pinHash
 * @returns {Promise<boolean>}
 */
const verifyPin = async (pin, pinHash) => {
  return await bcrypt.compare(String(pin), pinHash)
}

/**
 * Generate a JWT token for a guard
 * @param {Object} guard
 * @returns {string}
 */
const generateGuardToken = (guard) => {
  const payload = {
    guardId: guard.id,
    societyId: guard.society_id,
    name: guard.name,
    role: 'guard',
  }
  const secret = process.env.JWT_SECRET || 'gatezy_default_secret'
  return jwt.sign(payload, secret, { expiresIn: '7d' })
}

/**
 * Guard Login
 * Verifies guard credentials and returns JWT token and guard profile
 * @param {Object} params
 * @param {string} params.phone
 * @param {string|number} params.pin
 * @returns {Promise<Object>}
 */
const loginGuard = async ({ phone, pin }) => {
  if (!phone || !pin) {
    throw new AuthError('Phone number and PIN are required.', 400)
  }

  const cleanPhone = String(phone).trim()

  // Find guard by phone number
  const result = await db.query(
    `SELECT id, society_id, name, phone, pin_hash, is_active
     FROM guards
     WHERE phone = $1
     LIMIT 1`,
    [cleanPhone]
  )

  if (result.rows.length === 0) {
    logger.warn(`Failed login attempt for unknown phone: ${cleanPhone}`)
    throw new AuthError('Invalid phone number or PIN.', 401)
  }

  const guard = result.rows[0]

  // Check if guard account is active
  if (!guard.is_active) {
    logger.warn(`Login attempt for inactive guard: ${guard.id} (${cleanPhone})`)
    throw new AuthError('Guard account is inactive. Please contact your society administrator.', 403)
  }

  // Verify PIN with bcrypt
  const isPinValid = await verifyPin(pin, guard.pin_hash)
  if (!isPinValid) {
    logger.warn(`Invalid PIN attempt for guard: ${guard.id} (${cleanPhone})`)
    throw new AuthError('Invalid phone number or PIN.', 401)
  }

  // Generate JWT token
  const token = generateGuardToken(guard)

  logger.info(`Guard logged in successfully: ${guard.name} (${guard.id})`)

  return {
    success: true,
    message: 'Login successful.',
    token,
    guard: {
      id: guard.id,
      societyId: guard.society_id,
      name: guard.name,
      phone: guard.phone,
      role: 'guard',
    },
  }
}

/**
 * Start Guard Shift
 * Inserts a new active shift record into the shifts table
 * @param {Object} params
 * @param {string} params.guardId
 * @param {string} params.societyId
 * @returns {Promise<Object>}
 */
const startShift = async ({ guardId, societyId }) => {
  if (!guardId || !societyId) {
    throw new AuthError('Guard ID and Society ID are required to start a shift.', 400)
  }

  // Create new shift row in shifts table
  const insertResult = await db.query(
    `INSERT INTO shifts (guard_id, society_id, started_at, status)
     VALUES ($1, $2, NOW(), 'active')
     RETURNING id, guard_id, society_id, started_at, ended_at, total_visitors, status`,
    [guardId, societyId]
  )

  const shift = insertResult.rows[0]
  logger.info(`Shift started: Shift ${shift.id} for Guard ${guardId} in Society ${societyId}`)

  return {
    success: true,
    message: 'Shift started successfully.',
    shift,
  }
}

module.exports = {
  AuthError,
  hashPin,
  verifyPin,
  generateGuardToken,
  loginGuard,
  startShift,
}
