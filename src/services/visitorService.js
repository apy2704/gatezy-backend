// src/services/visitorService.js
const db = require('../utils/db')
const logger = require('../utils/logger')
const notificationService = require('./notificationService')
const { scheduleEscalation, cancelEscalation } = require('../jobs/escalationJob')

/**
 * Custom error with HTTP status code
 */
class VisitorError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'VisitorError'
    this.statusCode = statusCode
  }
}

/**
 * Query society name from societies table
 * @param {string} societyId
 * @returns {Promise<string>}
 */
const getSocietyName = async (societyId) => {
  if (!societyId) return 'GATEZY Society'
  try {
    const result = await db.query(
      `SELECT name FROM societies WHERE id = $1 LIMIT 1`,
      [societyId]
    )
    return result.rows.length > 0 ? result.rows[0].name : 'GATEZY Society'
  } catch (err) {
    logger.warn(`Failed to fetch society name for ${societyId}:`, err.message)
    return 'GATEZY Society'
  }
}

/**
 * Find flat by number and optional block within a society
 * @param {Object} params
 * @param {string} params.societyId
 * @param {string} params.flatNumber
 * @param {string} [params.block]
 * @returns {Promise<Object>}
 */
const findFlat = async ({ societyId, flatNumber, block }) => {
  const cleanFlat = String(flatNumber).trim()
  const cleanBlock = block ? String(block).trim() : null

  let queryText
  let queryParams

  if (cleanBlock) {
    queryText = `
      SELECT id, society_id, flat_number, block, floor, is_occupied
      FROM flats
      WHERE society_id = $1 
        AND LOWER(TRIM(flat_number)) = LOWER(TRIM($2))
        AND LOWER(TRIM(block)) = LOWER(TRIM($3))
      LIMIT 1
    `
    queryParams = [societyId, cleanFlat, cleanBlock]
  } else {
    queryText = `
      SELECT id, society_id, flat_number, block, floor, is_occupied
      FROM flats
      WHERE society_id = $1 
        AND LOWER(TRIM(flat_number)) = LOWER(TRIM($2))
        AND (block IS NULL OR TRIM(block) = '')
      LIMIT 1
    `
    queryParams = [societyId, cleanFlat]
  }

  let result = await db.query(queryText, queryParams)

  // Fallback: if block was not provided or not matched with NULL block, try matching flat_number regardless of block if unique
  if (result.rows.length === 0 && !cleanBlock) {
    const fallbackResult = await db.query(
      `SELECT id, society_id, flat_number, block, floor, is_occupied
       FROM flats
       WHERE society_id = $1 AND LOWER(TRIM(flat_number)) = LOWER(TRIM($2))
       LIMIT 1`,
      [societyId, cleanFlat]
    )
    if (fallbackResult.rows.length > 0) {
      result = fallbackResult
    }
  }

  if (result.rows.length === 0) {
    const flatDisplay = cleanBlock ? `${cleanFlat} (Block ${cleanBlock})` : cleanFlat
    throw new VisitorError(`Flat ${flatDisplay} was not found in this society.`, 404)
  }

  return result.rows[0]
}

/**
 * Check if visitor phone has an active pre-approval for today and current time
 * @param {Object} params
 * @param {string} params.flatId
 * @param {string} params.visitorPhone
 * @returns {Promise<Object|null>}
 */
const checkPreapproval = async ({ flatId, visitorPhone }) => {
  if (!visitorPhone) return null

  const cleanPhone = String(visitorPhone).trim()
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const todayDay = dayNames[new Date().getDay()] // e.g. 'mon', 'tue'

  const result = await db.query(
    `SELECT id, flat_id, created_by, visitor_name, visitor_phone, purpose, allowed_days, time_from, time_to, is_active
     FROM preapprovals
     WHERE flat_id = $1
       AND visitor_phone = $2
       AND is_active = TRUE
       AND (
         allowed_days ILIKE '%' || $3 || '%'
         OR allowed_days ILIKE '%all%'
         OR allowed_days ILIKE '%everyday%'
       )
       AND CURRENT_TIME BETWEEN time_from AND time_to
     ORDER BY created_at DESC
     LIMIT 1`,
    [flatId, cleanPhone, todayDay]
  )

  return result.rows.length > 0 ? result.rows[0] : null
}

/**
 * Query last 5 visits for returning visitor in the society
 * @param {Object} params
 * @param {string} params.societyId
 * @param {string} params.visitorPhone
 * @returns {Promise<Array>}
 */
const getReturningVisits = async ({ societyId, visitorPhone }) => {
  if (!visitorPhone) return []

  const cleanPhone = String(visitorPhone).trim()

  const result = await db.query(
    `SELECT vr.id, vr.visitor_name, vr.visitor_phone, vr.purpose, vr.status, vr.created_at,
            f.flat_number, f.block
     FROM visitor_requests vr
     JOIN flats f ON f.id = vr.flat_id
     WHERE vr.society_id = $1
       AND vr.visitor_phone = $2
     ORDER BY vr.created_at DESC
     LIMIT 5`,
    [societyId, cleanPhone]
  )

  return result.rows
}

/**
 * Create Visitor Request
 * Flow:
 * 1) Find flat in society
 * 2) Check active preapprovals
 * 3) If not preapproved, get last 5 returning visits
 * 4) Save visitor_request record
 * 5) If NOT preapproved: fetch primary resident and send WhatsApp notification
 *    If preapproved: skip WhatsApp
 * 6) Return saved request + flat details + preapproval status
 * @param {Object} params
 * @returns {Promise<Object>}
 */
const createVisitorRequest = async ({
  societyId,
  guardId,
  shiftId,
  visitorName,
  visitorPhone,
  purpose,
  flatNumber,
  block,
  photoBase64,
}) => {
  if (!visitorName || !flatNumber || !purpose) {
    throw new VisitorError('visitorName, flatNumber, and purpose are required.', 400)
  }

  // Ensure an active shift exists or resolve shiftId
  let resolvedShiftId = shiftId
  if (!resolvedShiftId) {
    const shiftCheck = await db.query(
      `SELECT id FROM shifts WHERE guard_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      [guardId]
    )
    if (shiftCheck.rows.length > 0) {
      resolvedShiftId = shiftCheck.rows[0].id
    } else {
      // Auto-start active shift if guard has none currently open
      const autoShift = await db.query(
        `INSERT INTO shifts (guard_id, society_id, started_at, status)
         VALUES ($1, $2, NOW(), 'active')
         RETURNING id`,
        [guardId, societyId]
      )
      resolvedShiftId = autoShift.rows[0].id
    }
  }

  // 1) Find the flat
  const flat = await findFlat({ societyId, flatNumber, block })

  const cleanPhone = visitorPhone ? String(visitorPhone).trim() : null

  // 2) Check preapproval
  const matchedPreapproval = await checkPreapproval({
    flatId: flat.id,
    visitorPhone: cleanPhone,
  })

  const isPreapproved = !!matchedPreapproval
  const status = isPreapproved ? 'allowed' : 'pending'
  const resolvedAt = isPreapproved ? new Date() : null

  // 3) Check returning visitor if not preapproved
  let returningVisits = []
  if (!isPreapproved && cleanPhone) {
    returningVisits = await getReturningVisits({ societyId, visitorPhone: cleanPhone })
  }

  // 4) Save visitor_request to database
  const insertResult = await db.query(
    `INSERT INTO visitor_requests (
       society_id,
       flat_id,
       guard_id,
       shift_id,
       visitor_name,
       visitor_phone,
       purpose,
       photo_url,
       status,
       exit_status,
       is_preapproved,
       resolved_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'inside', $10, $11)
     RETURNING id, society_id, flat_id, guard_id, shift_id, visitor_name, visitor_phone,
               purpose, photo_url, status, exit_status, is_emergency, emergency_type,
               is_preapproved, created_at, resolved_at`,
    [
      societyId,
      flat.id,
      guardId,
      resolvedShiftId,
      String(visitorName).trim(),
      cleanPhone,
      String(purpose).trim(),
      photoBase64 || null,
      status,
      isPreapproved,
      resolvedAt,
    ]
  )

  const savedRequest = insertResult.rows[0]

  logger.info(
    `Visitor request created: ${savedRequest.id} for ${savedRequest.visitor_name} to Flat ${flat.flat_number} (${status})`
  )

  // 5) WhatsApp Notification Integration
  // If isPreapproved is FALSE: fetch primary resident and send WhatsApp notification
  // If isPreapproved is TRUE: skip WhatsApp entirely
  if (!isPreapproved) {
    try {
      const societyName = await getSocietyName(societyId)

      // Fetch primary resident for the flat
      logger.info(
        `[WhatsApp Flow] Looking up primary resident for flat_id=${flat.id} (Flat ${flat.flat_number}, Block ${flat.block || 'N/A'})`
      )

      let residentResult = await db.query(
        `SELECT id, name, phone, alt_phone, role, is_primary
         FROM residents
         WHERE flat_id = $1 AND is_primary = TRUE
         LIMIT 1`,
        [flat.id]
      )

      // Fallback to any resident if is_primary not explicitly marked
      if (residentResult.rows.length === 0) {
        logger.info(
          `[WhatsApp Flow] No is_primary=true resident found for flat_id=${flat.id}. Falling back to earliest registered resident.`
        )
        residentResult = await db.query(
          `SELECT id, name, phone, alt_phone, role, is_primary
           FROM residents
           WHERE flat_id = $1
           ORDER BY created_at ASC
           LIMIT 1`,
          [flat.id]
        )
      }

      if (residentResult.rows.length > 0) {
        const primaryResident = residentResult.rows[0]
        logger.info(
          `[WhatsApp Flow] Resident found: id=${primaryResident.id}, name=${primaryResident.name}, phone=${primaryResident.phone || 'NULL'}, is_primary=${primaryResident.is_primary}`
        )

        // Guard: skip WhatsApp if resident has no phone number
        if (!primaryResident.phone || String(primaryResident.phone).trim() === '') {
          logger.warn(
            `[WhatsApp Flow] Resident ${primaryResident.name} (id=${primaryResident.id}) for flat_id=${flat.id} has no phone number — skipping WhatsApp notification.`
          )
        } else {
          const flatDisplay = flat.block
            ? `${flat.flat_number} (Block ${flat.block})`
            : flat.flat_number

          logger.info(
            `[WhatsApp Flow] Attempting to send visitor alert to ${primaryResident.phone} for Request ${savedRequest.id}`
          )

          const alertRes = await notificationService.sendVisitorAlert({
            toPhone: primaryResident.phone,
            visitorName: savedRequest.visitor_name,
            purpose: savedRequest.purpose,
            flatNumber: flatDisplay,
            societyName,
            requestId: savedRequest.id,
            photoUrl: savedRequest.photo_url,
          })

          if (alertRes.success) {
            logger.info(
              `[WhatsApp Flow] ✅ Alert sent successfully to ${primaryResident.name} (${primaryResident.phone}) for Request ${savedRequest.id}` +
              (alertRes.mocked ? ' [SIMULATED — Twilio not configured]' : ` [SID: ${alertRes.messageSid}]`)
            )
          } else {
            logger.warn(
              `[WhatsApp Flow] ❌ Alert FAILED for Request ${savedRequest.id} to ${primaryResident.phone}: ${alertRes.error}`
            )
          }
        }
      } else {
        logger.warn(
          `[WhatsApp Flow] No primary resident found for flat_id=${flat.id} (Flat ${flat.flat_number}, Block ${flat.block || 'N/A'}) — skipping WhatsApp notification.`
        )
      }
    } catch (notifyErr) {
      // Do not fail the visitor request if notification fails
      logger.error('[WhatsApp Flow] Exception while processing WhatsApp notification:', notifyErr.message)
    }

    // Schedule escalation chain
    try {
      await scheduleEscalation(savedRequest.id, flat.id, societyId)
      logger.info(`Escalation scheduled for request ${savedRequest.id}`)
    } catch (escErr) {
      logger.error(`Failed to schedule escalation for request ${savedRequest.id}:`, escErr.message)
    }
  } else {
    logger.info(
      `[WhatsApp Flow] Pre-approved visitor ${savedRequest.visitor_name} auto-allowed. WhatsApp notification skipped.`
    )
  }

  // 6) Return response object with flat details and preapproval status
  return {
    success: true,
    message: isPreapproved
      ? 'Visitor pre-approved and granted entry.'
      : 'Visitor request created successfully.',
    isPreapproved,
    request: {
      ...savedRequest,
      flat: {
        id: flat.id,
        flatNumber: flat.flat_number,
        block: flat.block,
        floor: flat.floor,
      },
    },
    preapproval: matchedPreapproval || null,
    returningVisits,
  }
}

/**
 * Get active visitors currently inside the society
 * Uses the current_visitors database view
 * @param {string} societyId
 * @returns {Promise<Object>}
 */
const getActiveVisitors = async (societyId) => {
  if (!societyId) {
    throw new VisitorError('Society ID is required.', 400)
  }

  const result = await db.query(
    `SELECT id, society_id, visitor_name, visitor_phone, purpose, photo_url,
            entered_at, flat_number, block, guard_name
     FROM current_visitors
     WHERE society_id = $1
     ORDER BY entered_at DESC`,
    [societyId]
  )

  return {
    success: true,
    message: 'Active visitors retrieved successfully.',
    count: result.rows.length,
    visitors: result.rows,
  }
}

/**
 * Mark a visitor as exited
 * Updates exit_status to 'exited' and exited_at to NOW()
 * @param {Object} params
 * @param {string} params.visitorRequestId
 * @param {string} params.societyId
 * @returns {Promise<Object>}
 */
const markVisitorExit = async ({ visitorRequestId, societyId }) => {
  if (!visitorRequestId) {
    throw new VisitorError('Visitor request ID is required.', 400)
  }

  const result = await db.query(
    `UPDATE visitor_requests
     SET exit_status = 'exited',
         exited_at = NOW()
     WHERE id = $1 AND society_id = $2
     RETURNING id, society_id, flat_id, guard_id, visitor_name, visitor_phone,
               purpose, status, exit_status, exited_at, created_at`,
    [visitorRequestId, societyId]
  )

  if (result.rows.length === 0) {
    throw new VisitorError('Visitor request not found in this society.', 404)
  }

  const updatedVisitor = result.rows[0]
  logger.info(`Visitor marked as exited: ${updatedVisitor.visitor_name} (${updatedVisitor.id})`)

  return {
    success: true,
    message: 'Visitor marked as exited successfully.',
    visitor: updatedVisitor,
  }
}

/**
 * Resolve a visitor request (allowed or denied).
 * Updates visitor_requests status, sets resolved_at = NOW(),
 * cancels all pending escalation jobs, updates/records approval in approvals table,
 * and returns the updated request.
 * Called when resident replies via WhatsApp webhook.
 *
 * @param {string} requestId - UUID of the visitor request
 * @param {string} decision - 'allow' | 'allowed' | 'deny' | 'denied' | '1' | '2'
 * @param {string} [channel='whatsapp'] - 'whatsapp' | 'voice_call' | 'manual'
 * @param {string} [residentId] - Optional UUID of resident who made the decision
 * @returns {Promise<Object>} The updated visitor request object
 */
const resolveVisitorRequest = async (requestId, decision, channel = 'whatsapp', residentId = null) => {
  if (!requestId) {
    throw new VisitorError('requestId is required to resolve visitor request.', 400)
  }

  const cleanDecision = String(decision).toLowerCase().trim()
  const isAllowed = cleanDecision === 'allow' || cleanDecision === 'allowed' || cleanDecision === '1'
  const normalizedDecision = isAllowed ? 'allow' : 'deny'
  const requestStatus = isAllowed ? 'allowed' : 'denied'
  const validChannels = ['whatsapp', 'voice_call', 'manual']
  const normalizedChannel = validChannels.includes(channel) ? channel : 'whatsapp'

  // 1. Update visitor_requests status to 'allowed' or 'denied' and set resolved_at = NOW()
  const updateResult = await db.query(
    `UPDATE visitor_requests
     SET status = $1,
         resolved_at = NOW()
     WHERE id = $2
     RETURNING id, society_id, flat_id, guard_id, shift_id, visitor_name, visitor_phone,
               purpose, photo_url, status, exit_status, is_emergency, emergency_type,
               is_preapproved, created_at, resolved_at`,
    [requestStatus, requestId]
  )

  if (updateResult.rows.length === 0) {
    throw new VisitorError(`Visitor request ${requestId} not found.`, 404)
  }

  const updatedRequest = updateResult.rows[0]

  // 2. Call cancelEscalation(requestId) to stop all pending jobs
  try {
    await cancelEscalation(requestId)
  } catch (cancelErr) {
    logger.warn(`Failed to cancel escalation for request ${requestId}:`, cancelErr.message)
  }

  // 3. Update the approval in approvals table
  try {
    let resolvedResidentId = residentId
    if (!resolvedResidentId) {
      const resResult = await db.query(
        `SELECT id FROM residents WHERE flat_id = $1 ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
        [updatedRequest.flat_id]
      )
      if (resResult.rows.length > 0) {
        resolvedResidentId = resResult.rows[0].id
      }
    }

    if (resolvedResidentId) {
      await db.query(
        `INSERT INTO approvals (request_id, resident_id, decision, channel, escalation_step, decided_at)
         VALUES ($1, $2, $3, $4, 1, NOW())
         ON CONFLICT (request_id)
         DO UPDATE SET
           resident_id = EXCLUDED.resident_id,
           decision = EXCLUDED.decision,
           channel = EXCLUDED.channel,
           decided_at = NOW()`,
        [requestId, resolvedResidentId, normalizedDecision, normalizedChannel]
      )
    }
  } catch (approvalErr) {
    logger.error(`Failed to record approval for request ${requestId}:`, approvalErr.message)
  }

  logger.info(`Visitor request ${requestId} resolved: status = ${requestStatus} by channel = ${normalizedChannel}`)

  // 4. Return updated request
  return updatedRequest
}

/**
 * Create Emergency Visitor Request
 * Flow:
 * 1) Find flat
 * 2) Ensure active shift
 * 3) Insert visitor_request with is_emergency=true, status='allowed', exit_status='inside', resolved_at=NOW()
 * 4) Fetch society details (secretary_phone) and guard name
 * 5) Send Admin Alert to secretary via WhatsApp (does NOT notify resident)
 * 6) Return saved emergency entry
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
const createEmergencyRequest = async ({
  societyId,
  guardId,
  guardName,
  shiftId,
  emergencyType,
  flatNumber,
  block,
}) => {
  if (!emergencyType) {
    throw new VisitorError('emergencyType is required (e.g. ambulance, police, fire).', 400)
  }

  const cleanEmergencyType = String(emergencyType).toLowerCase().trim()

  // 1. Resolve flat
  let flat = null
  if (flatNumber) {
    flat = await findFlat({ societyId, flatNumber, block })
  } else {
    // If no specific flat provided, grab first flat in society
    const firstFlatRes = await db.query(
      `SELECT id, flat_number, block, floor FROM flats WHERE society_id = $1 LIMIT 1`,
      [societyId]
    )
    if (firstFlatRes.rows.length > 0) {
      flat = firstFlatRes.rows[0]
    } else {
      throw new VisitorError('No flat found in society for emergency entry.', 404)
    }
  }

  // 2. Ensure active shift
  let resolvedShiftId = shiftId
  if (!resolvedShiftId) {
    const shiftCheck = await db.query(
      `SELECT id FROM shifts WHERE guard_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1`,
      [guardId]
    )
    if (shiftCheck.rows.length > 0) {
      resolvedShiftId = shiftCheck.rows[0].id
    } else {
      const autoShift = await db.query(
        `INSERT INTO shifts (guard_id, society_id, started_at, status)
         VALUES ($1, $2, NOW(), 'active')
         RETURNING id`,
        [guardId, societyId]
      )
      resolvedShiftId = autoShift.rows[0].id
    }
  }

  const formattedVisitorName = `${cleanEmergencyType.toUpperCase()} Emergency Vehicle`
  const purpose = `Emergency - ${cleanEmergencyType.toUpperCase()}`

  // 3. Insert into visitor_requests
  const insertResult = await db.query(
    `INSERT INTO visitor_requests (
       society_id,
       flat_id,
       guard_id,
       shift_id,
       visitor_name,
       visitor_phone,
       purpose,
       photo_url,
       status,
       exit_status,
       is_emergency,
       emergency_type,
       is_preapproved,
       resolved_at
     )
     VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, 'allowed', 'inside', TRUE, $7, FALSE, NOW())
     RETURNING id, society_id, flat_id, guard_id, shift_id, visitor_name, visitor_phone,
               purpose, photo_url, status, exit_status, is_emergency, emergency_type,
               is_preapproved, created_at, resolved_at`,
    [
      societyId,
      flat.id,
      guardId,
      resolvedShiftId,
      formattedVisitorName,
      purpose,
      cleanEmergencyType,
    ]
  )

  const savedRequest = insertResult.rows[0]
  logger.info(`🚨 Emergency entry granted: ${savedRequest.id} (${cleanEmergencyType}) for Flat ${flat.flat_number}`)

  // 4. Fetch society secretary info & guard info for Admin WhatsApp Alert
  try {
    const socRes = await db.query(
      `SELECT name, secretary_phone FROM societies WHERE id = $1 LIMIT 1`,
      [societyId]
    )

    let resolvedGuardName = guardName
    if (!resolvedGuardName) {
      const gRes = await db.query(`SELECT name FROM guards WHERE id = $1 LIMIT 1`, [guardId])
      if (gRes.rows.length > 0) resolvedGuardName = gRes.rows[0].name
    }

    if (socRes.rows.length > 0 && socRes.rows[0].secretary_phone) {
      const society = socRes.rows[0]
      await notificationService.sendAdminAlert({
        toPhone: society.secretary_phone,
        societyName: society.name,
        guardName: resolvedGuardName || 'Gate Security',
        emergencyType: cleanEmergencyType,
        requestId: savedRequest.id,
      })
      logger.info(`🚨 Admin WhatsApp alert dispatched to Secretary at ${society.secretary_phone}`)
    } else {
      logger.warn(`No secretary phone configured for society ${societyId}. Admin alert skipped.`)
    }
  } catch (alertErr) {
    logger.error('Failed to send admin emergency WhatsApp alert:', alertErr.message)
  }

  return {
    success: true,
    message: 'Emergency vehicle granted immediate entry. Society admin alerted.',
    request: {
      ...savedRequest,
      flat: {
        id: flat.id,
        flatNumber: flat.flat_number,
        block: flat.block,
        floor: flat.floor,
      },
    },
  }
}

/**
 * End Guard Shift & Dispatch Daily Summary Report to Society Secretary
 * @param {Object} params
 * @param {string} params.shiftId
 * @param {number} [params.totalVisitors]
 * @param {string} [params.guardId]
 * @param {string} [params.societyId]
 * @returns {Promise<Object>}
 */
const endShift = async ({ shiftId, totalVisitors, guardId, societyId }) => {
  if (!shiftId) {
    throw new VisitorError('shiftId is required to end shift.', 400)
  }

  // 1. Calculate visitor count if not explicitly provided
  let calculatedCount = totalVisitors
  if (calculatedCount === undefined || calculatedCount === null) {
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM visitor_requests WHERE shift_id = $1`,
      [shiftId]
    )
    calculatedCount = countRes.rows[0].cnt || 0
  }

  // 2. Update shifts table
  const updateRes = await db.query(
    `UPDATE shifts
     SET ended_at = NOW(),
         status = 'closed',
         total_visitors = $1
     WHERE id = $2
     RETURNING id, guard_id, society_id, started_at, ended_at, total_visitors, status`,
    [parseInt(calculatedCount) || 0, shiftId]
  )

  if (updateRes.rows.length === 0) {
    throw new VisitorError(`Shift ${shiftId} not found.`, 404)
  }

  const closedShift = updateRes.rows[0]
  const resolvedSocietyId = societyId || closedShift.society_id

  logger.info(`Shift closed: Shift ${closedShift.id} with ${closedShift.total_visitors} visitors`)

  // 3. Fetch today's society statistics
  let stats = {
    total: 0,
    allowed: 0,
    denied: 0,
    noResponse: 0,
    emergencies: 0,
  }

  try {
    const statsRes = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'allowed')::int AS allowed,
         COUNT(*) FILTER (WHERE status = 'denied')::int AS denied,
         COUNT(*) FILTER (WHERE status = 'no_response')::int AS no_response,
         COUNT(*) FILTER (WHERE is_emergency = TRUE)::int AS emergencies
       FROM visitor_requests
       WHERE society_id = $1 AND DATE(created_at) = CURRENT_DATE`,
      [resolvedSocietyId]
    )

    if (statsRes.rows.length > 0) {
      const row = statsRes.rows[0]
      stats = {
        total: row.total || 0,
        allowed: row.allowed || 0,
        denied: row.denied || 0,
        noResponse: row.no_response || 0,
        emergencies: row.emergencies || 0,
      }
    }

    // 4. Fetch society name and secretary phone to send daily summary report
    const socRes = await db.query(
      `SELECT name, secretary_phone FROM societies WHERE id = $1 LIMIT 1`,
      [resolvedSocietyId]
    )

    if (socRes.rows.length > 0 && socRes.rows[0].secretary_phone) {
      const society = socRes.rows[0]
      await notificationService.sendDailyReport({
        toPhone: society.secretary_phone,
        societyName: society.name,
        date: new Date().toISOString().split('T')[0],
        total: stats.total,
        allowed: stats.allowed,
        denied: stats.denied,
        noResponse: stats.noResponse,
        emergencies: stats.emergencies,
      })
      logger.info(`📊 Daily summary report sent to Secretary at ${society.secretary_phone}`)
    }
  } catch (statsErr) {
    logger.error('Failed to generate/send daily summary report on shift end:', statsErr.message)
  }

  return {
    success: true,
    message: 'Shift ended successfully.',
    shift: closedShift,
    stats,
  }
}

module.exports = {
  VisitorError,
  getSocietyName,
  findFlat,
  checkPreapproval,
  getReturningVisits,
  createVisitorRequest,
  getActiveVisitors,
  markVisitorExit,
  resolveVisitorRequest,
  createEmergencyRequest,
  endShift,
}
