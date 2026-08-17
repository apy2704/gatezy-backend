// src/routes/webhooks.js
const express = require('express')
const router = express.Router()
const twilio = require('twilio')
const db = require('../utils/db')
const logger = require('../utils/logger')
const { resolveVisitorRequest } = require('../services/visitorService')

/**
 * Clean phone number by removing 'whatsapp:' prefix, spaces, and formatting characters
 * @param {string} phone
 * @returns {string}
 */
const cleanPhoneNumber = (phone) => {
  if (!phone) return ''
  return String(phone).trim().replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
}

/**
 * Generate TwiML XML response string
 * @param {string} messageText
 * @returns {string}
 */
const generateTwiML = (messageText) => {
  try {
    const twiml = new twilio.twiml.MessagingResponse()
    twiml.message(messageText)
    return twiml.toString()
  } catch {
    const escaped = String(messageText)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
  }
}

/**
 * Parse incoming WhatsApp message text or button payload into a decision
 * @param {string} body
 * @returns {'allow' | 'deny' | 'wait' | null}
 */
const parseWhatsAppDecision = (body) => {
  if (!body) return null
  const text = String(body).toLowerCase().trim()

  // 1 or allow / approve
  if (text === '1' || text.includes('allow') || text.includes('approve') || text.startsWith('1')) {
    return 'allow'
  }

  // 2 or deny / reject
  if (text === '2' || text.includes('deny') || text.includes('reject') || text.startsWith('2')) {
    return 'deny'
  }

  // 3 or wait / hold
  if (text === '3' || text.includes('wait') || text.startsWith('3')) {
    return 'wait'
  }

  return null
}

/**
 * Core processor for incoming WhatsApp decision messages
 * @param {Object} params
 * @param {string} params.phone - Sender phone number
 * @param {string} params.body - Incoming message text or button payload
 * @returns {Promise<Object>} Result object with replyText and status
 */
const processIncomingWhatsApp = async ({ phone, body }) => {
  const cleanedPhone = cleanPhoneNumber(phone)
  const last10Digits = cleanedPhone.replace(/\D/g, '').slice(-10)

  logger.info(`[WhatsApp Webhook] Incoming message from: ${cleanedPhone} (raw: ${phone}), Body: "${body}"`)

  const decision = parseWhatsAppDecision(body)

  // 1. If none match
  if (!decision) {
    logger.info(`[WhatsApp Webhook] Unrecognized reply: "${body}" from ${cleanedPhone}`)
    return {
      success: false,
      decision: 'invalid',
      replyText: 'Please reply 1 to ALLOW, 2 to DENY, or 3 to ask visitor to WAIT.',
    }
  }

  // 2. If decision is wait (3 or wait)
  if (decision === 'wait') {
    logger.info(`[WhatsApp Webhook] Resident ${cleanedPhone} requested visitor to WAIT.`)
    return {
      success: true,
      decision: 'wait',
      replyText: 'We have notified the guard. Visitor will wait.',
    }
  }

  // 3. Find resident by phone in residents table
  const residentResult = await db.query(
    `SELECT id, flat_id, name, phone, alt_phone, is_primary
     FROM residents
     WHERE phone = $1
        OR alt_phone = $1
        OR RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2
        OR RIGHT(REGEXP_REPLACE(COALESCE(alt_phone, ''), '\\D', '', 'g'), 10) = $2
     ORDER BY is_primary DESC, created_at ASC
     LIMIT 1`,
    [cleanedPhone, last10Digits]
  )

  if (residentResult.rows.length === 0) {
    logger.warn(`[WhatsApp Webhook] No resident found for phone: ${cleanedPhone}`)
    return {
      success: false,
      decision,
      replyText: 'No registered resident found for this phone number.',
    }
  }

  const resident = residentResult.rows[0]

  // 4. Find latest pending visitor_request for that resident's flat
  const pendingReqResult = await db.query(
    `SELECT vr.id, vr.society_id, vr.flat_id, vr.visitor_name, vr.purpose, vr.status, vr.created_at,
            f.flat_number, f.block
     FROM visitor_requests vr
     JOIN flats f ON f.id = vr.flat_id
     WHERE vr.flat_id = $1 AND vr.status = 'pending'
     ORDER BY vr.created_at DESC
     LIMIT 1`,
    [resident.flat_id]
  )

  if (pendingReqResult.rows.length === 0) {
    logger.info(`[WhatsApp Webhook] No pending visitor request found for Flat ${resident.flat_id} (Resident: ${resident.name})`)
    return {
      success: false,
      decision,
      resident,
      replyText: 'No pending visitor request found.',
    }
  }

  const pendingRequest = pendingReqResult.rows[0]

  // 5. Call resolveVisitorRequest from visitorService
  const updatedRequest = await resolveVisitorRequest(
    pendingRequest.id,
    decision,
    'whatsapp',
    resident.id
  )

  const isAllowed = decision === 'allow'
  const replyText = isAllowed
    ? `✅ Entry ALLOWED for ${pendingRequest.visitor_name}. Guard has been notified.`
    : `⛔ Entry DENIED for ${pendingRequest.visitor_name}. Guard has been notified.`

  logger.info(
    `[WhatsApp Webhook] Resolved request ${pendingRequest.id} as ${decision.toUpperCase()} for visitor ${pendingRequest.visitor_name}`
  )

  return {
    success: true,
    decision,
    replyText,
    resident,
    request: updatedRequest,
  }
}

/**
 * Health check ping
 */
router.get('/ping', (req, res) => {
  res.json({ success: true, message: 'Webhooks route working' })
})

/**
 * POST /api/webhooks/whatsapp
 * Receives Twilio / AiSensy webhook (form-urlencoded or JSON)
 * Handles text replies & button replies
 */
router.post('/whatsapp', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    // Twilio sends 'From' (e.g. 'whatsapp:+919876543210')
    // Body can come from 'Body', 'ButtonPayload', 'ButtonText', or 'Payload'
    const fromPhone = req.body.From || req.body.from || req.body.phone || ''
    const rawBody = (
      req.body.Body ||
      req.body.ButtonPayload ||
      req.body.ButtonText ||
      req.body.Payload ||
      req.body.body ||
      req.body.text ||
      ''
    ).trim()

    const result = await processIncomingWhatsApp({
      phone: fromPhone,
      body: rawBody,
    })

    // Return TwiML XML response to Twilio
    const twimlResponse = generateTwiML(result.replyText)
    res.type('text/xml').send(twimlResponse)
  } catch (error) {
    logger.error('[WhatsApp Webhook] Error processing webhook:', error.message)
    const fallbackTwiML = generateTwiML('An error occurred while processing your response. Please try again.')
    res.type('text/xml').status(200).send(fallbackTwiML)
  }
})

/**
 * POST /api/webhooks/test
 * Test endpoint accepting JSON payload: { phone, body }
 * Simulates WhatsApp webhook for testing without Twilio
 */
router.post('/test', express.json(), async (req, res) => {
  try {
    const { phone, body, from, text } = req.body
    const inputPhone = phone || from
    const inputBody = body || text

    if (!inputPhone || !inputBody) {
      return res.status(400).json({
        success: false,
        message: 'Both phone and body fields are required.',
      })
    }

    const result = await processIncomingWhatsApp({
      phone: inputPhone,
      body: inputBody,
    })

    return res.status(200).json({
      success: result.success,
      decision: result.decision,
      message: result.replyText,
      resident: result.resident || null,
      request: result.request || null,
    })
  } catch (error) {
    logger.error('[WhatsApp Webhook Test] Error:', error.message)
    return res.status(500).json({
      success: false,
      message: error.message,
    })
  }
})

module.exports = router