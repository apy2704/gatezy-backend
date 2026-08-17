// src/jobs/escalationJob.js
const { escalationQueue } = require('../utils/redis')
const notificationService = require('../services/notificationService')
const db = require('../utils/db')
const logger = require('../utils/logger')

/**
 * Schedule escalation jobs for a visitor request.
 * Creates 4 delayed Bull jobs:
 * - Step 1: 30s delay  -> Reminder step 1 (WhatsApp to primary resident)
 * - Step 2: 60s delay  -> Reminder step 2 (Urgent WhatsApp to primary resident)
 * - Step 3: 90s delay  -> WhatsApp to alternate contact (alt_phone)
 * - Step 4: 120s delay -> Voice call escalation (mocked)
 *
 * @param {string} requestId - UUID of the visitor request
 * @param {string} flatId - UUID of the flat
 * @param {string} societyId - UUID of the society
 * @returns {Promise<Array<Object>>} List of scheduled escalation records
 */
const scheduleEscalation = async (requestId, flatId, societyId) => {
  if (!requestId || !flatId || !societyId) {
    logger.error('scheduleEscalation error: requestId, flatId, and societyId are required.')
    throw new Error('requestId, flatId, and societyId are required to schedule escalation.')
  }

  const steps = [
    { step: 1, delay: 30 * 1000, channel: 'whatsapp' },
    { step: 2, delay: 60 * 1000, channel: 'whatsapp' },
    { step: 3, delay: 90 * 1000, channel: 'whatsapp_alt' },
    { step: 4, delay: 120 * 1000, channel: 'voice_call' },
  ]

  const scheduled = []

  for (const s of steps) {
    try {
      const job = await escalationQueue.add(
        {
          requestId,
          flatId,
          societyId,
          step: s.step,
          channel: s.channel,
        },
        {
          delay: s.delay,
        }
      )

      const dbRes = await db.query(
        `INSERT INTO escalations (request_id, step, channel, status, job_id)
         VALUES ($1, $2, $3, 'queued', $4)
         RETURNING id, request_id, step, channel, status, job_id`,
        [requestId, s.step, s.channel, String(job.id)]
      )

      scheduled.push(dbRes.rows[0])
      logger.info(
        `[Escalation] Scheduled Step ${s.step} (${s.channel}) for Request ${requestId} with Bull job ${job.id} (fires in ${s.delay / 1000}s)`
      )
    } catch (err) {
      logger.error(
        `[Escalation] Failed to schedule Step ${s.step} for Request ${requestId}:`,
        err.message
      )
      throw err
    }
  }

  return scheduled
}

/**
 * Cancel all pending escalation jobs for a visitor request.
 * Called when a resident responds (allows or denies entry).
 *
 * @param {string} requestId - UUID of the visitor request
 * @returns {Promise<{ cancelledCount: number }>}
 */
const cancelEscalation = async (requestId) => {
  if (!requestId) {
    logger.warn('[Escalation] cancelEscalation called without requestId')
    return { cancelledCount: 0 }
  }

  try {
    // 1. Fetch all queued jobs from database for this request
    const dbRes = await db.query(
      `SELECT id, job_id, step, channel
       FROM escalations
       WHERE request_id = $1 AND status = 'queued'`,
      [requestId]
    )

    const queuedEscalations = dbRes.rows

    // 2. Remove each job from Bull queue
    for (const esc of queuedEscalations) {
      if (esc.job_id) {
        try {
          const job = await escalationQueue.getJob(esc.job_id)
          if (job) {
            await job.remove()
            logger.info(`[Escalation] Removed Bull job ${esc.job_id} (Step ${esc.step}) for Request ${requestId}`)
          }
        } catch (jobErr) {
          logger.warn(`[Escalation] Could not remove Bull job ${esc.job_id}:`, jobErr.message)
        }
      }
    }

    // 3. Mark database records as cancelled
    const updateRes = await db.query(
      `UPDATE escalations
       SET status = 'cancelled', cancelled_at = NOW()
       WHERE request_id = $1 AND status = 'queued'
       RETURNING id`,
      [requestId]
    )

    const cancelledCount = updateRes.rowCount || 0
    logger.info(`[Escalation] Cancelled ${cancelledCount} pending escalation(s) for Request ${requestId}`)

    return { cancelledCount }
  } catch (err) {
    logger.error(`[Escalation] Error cancelling escalations for Request ${requestId}:`, err.message)
    throw err
  }
}

/**
 * Bull Queue Processor for Escalation Jobs
 */
escalationQueue.process(async (job) => {
  const { requestId, flatId, societyId, step, channel } = job.data
  logger.info(`[Escalation Queue] Processing Job ${job.id} — Step ${step} for Request ${requestId}`)

  try {
    // 1. Check if visitor request is still pending
    const reqRes = await db.query(
      `SELECT id, status, visitor_name, purpose, flat_id, society_id
       FROM visitor_requests
       WHERE id = $1`,
      [requestId]
    )

    if (reqRes.rows.length === 0) {
      logger.warn(`[Escalation Queue] Visitor request ${requestId} not found. Skipping Step ${step}.`)
      return { skipped: true, reason: 'Request not found' }
    }

    const visitorReq = reqRes.rows[0]

    // If status is 'allowed', 'denied', or anything other than 'pending' -> skip silently
    if (visitorReq.status !== 'pending') {
      logger.info(
        `[Escalation Queue] Request ${requestId} status is '${visitorReq.status}' (not pending). Skipping Step ${step} silently.`
      )
      // Update escalation record to cancelled if it was still queued
      await db.query(
        `UPDATE escalations
         SET status = 'cancelled', cancelled_at = NOW()
         WHERE request_id = $1 AND step = $2 AND status = 'queued'`,
        [requestId, step]
      )
      return { skipped: true, reason: `Status is ${visitorReq.status}` }
    }

    // 2. Mark this escalation step as fired in database
    await db.query(
      `UPDATE escalations
       SET status = 'fired', fired_at = NOW()
       WHERE request_id = $1 AND step = $2 AND status = 'queued'`,
      [requestId, step]
    )

    // 3. Execute step-specific logic
    switch (step) {
      case 1: {
        // Step 1: Reminder step 1 (WhatsApp to primary resident)
        let residentRes = await db.query(
          `SELECT id, name, phone
           FROM residents
           WHERE flat_id = $1 AND is_primary = TRUE
           LIMIT 1`,
          [flatId]
        )

        // Fallback to first registered resident if no is_primary
        if (residentRes.rows.length === 0) {
          residentRes = await db.query(
            `SELECT id, name, phone
             FROM residents
             WHERE flat_id = $1
             ORDER BY created_at ASC
             LIMIT 1`,
            [flatId]
          )
        }

        if (residentRes.rows.length > 0 && residentRes.rows[0].phone) {
          const resident = residentRes.rows[0]
          logger.info(`[Escalation Step 1] Sending Reminder 1 to ${resident.phone} for Request ${requestId}`)
          await notificationService.sendReminder({
            toPhone: resident.phone,
            visitorName: visitorReq.visitor_name,
            step: 1,
            requestId,
          })
        } else {
          logger.warn(`[Escalation Step 1] No valid resident phone found for flat ${flatId}. Skipping message send.`)
        }
        break
      }

      case 2: {
        // Step 2: Reminder step 2 (Urgent WhatsApp to primary resident)
        let residentRes = await db.query(
          `SELECT id, name, phone
           FROM residents
           WHERE flat_id = $1 AND is_primary = TRUE
           LIMIT 1`,
          [flatId]
        )

        // Fallback to first registered resident if no is_primary
        if (residentRes.rows.length === 0) {
          residentRes = await db.query(
            `SELECT id, name, phone
             FROM residents
             WHERE flat_id = $1
             ORDER BY created_at ASC
             LIMIT 1`,
            [flatId]
          )
        }

        if (residentRes.rows.length > 0 && residentRes.rows[0].phone) {
          const resident = residentRes.rows[0]
          logger.info(`[Escalation Step 2] Sending Reminder 2 (Urgent) to ${resident.phone} for Request ${requestId}`)
          await notificationService.sendReminder({
            toPhone: resident.phone,
            visitorName: visitorReq.visitor_name,
            step: 2,
            requestId,
          })
        } else {
          logger.warn(`[Escalation Step 2] No valid resident phone found for flat ${flatId}. Skipping message send.`)
        }
        break
      }

      case 3: {
        // Step 3: Forward to alternate number (fetch alt_phone from residents table where flat_id matches and is_primary = true)
        let residentRes = await db.query(
          `SELECT id, name, phone, alt_phone
           FROM residents
           WHERE flat_id = $1 AND is_primary = TRUE
           LIMIT 1`,
          [flatId]
        )

        // Fallback to any resident with alt_phone if primary doesn't have one
        if (residentRes.rows.length === 0 || !residentRes.rows[0].alt_phone) {
          residentRes = await db.query(
            `SELECT id, name, phone, alt_phone
             FROM residents
             WHERE flat_id = $1 AND alt_phone IS NOT NULL AND TRIM(alt_phone) != ''
             ORDER BY created_at ASC
             LIMIT 1`,
            [flatId]
          )
        }

        const resident = residentRes.rows[0]
        const altPhone = resident ? resident.alt_phone : null

        if (altPhone && String(altPhone).trim() !== '') {
          // Fetch flat details for display
          const flatRes = await db.query(
            `SELECT flat_number, block FROM flats WHERE id = $1 LIMIT 1`,
            [flatId]
          )
          const flat = flatRes.rows[0]
          const flatDisplay = flat
            ? flat.block
              ? `${flat.flat_number} (Block ${flat.block})`
              : flat.flat_number
            : 'N/A'

          logger.info(
            `[Escalation Step 3] Forwarding alert to alternate number ${altPhone} for Flat ${flatDisplay} (Request ${requestId})`
          )
          await notificationService.sendToAltNumber({
            toPhone: altPhone,
            visitorName: visitorReq.visitor_name,
            flatNumber: flatDisplay,
            requestId,
          })
        } else {
          logger.warn(
            `[Escalation Step 3] No alternate phone (alt_phone) found for flat ${flatId} (is_primary = true). Skipping Step 3 alert.`
          )
        }
        break
      }

      case 4: {
        // Step 4: Voice call mock
        logger.info(
          `[Escalation Step 4] voice call would fire here (Request: ${requestId}, Flat: ${flatId}, Society: ${societyId})`
        )
        break
      }

      default:
        logger.warn(`[Escalation Queue] Unrecognized escalation step ${step} for Request ${requestId}`)
        break
    }

    return { success: true, step, requestId }
  } catch (err) {
    logger.error(`[Escalation Queue] Error processing Job ${job.id} (Step ${step}, Request ${requestId}):`, err.message)

    // Mark escalation as failed
    try {
      await db.query(
        `UPDATE escalations
         SET status = 'failed'
         WHERE request_id = $1 AND step = $2 AND status = 'queued'`,
        [requestId, step]
      )
    } catch (dbErr) {
      logger.error('[Escalation Queue] Failed to update escalation status to failed:', dbErr.message)
    }

    throw err
  }
})

logger.info('Escalation job processor initialized')

module.exports = {
  scheduleEscalation,
  cancelEscalation,
}