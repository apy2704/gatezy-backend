// src/services/notificationService.js
require('dotenv').config()
const twilio = require('twilio')
const logger = require('../utils/logger')

/**
 * Get or initialize Twilio client in production
 */
const getTwilioClient = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN

  if (!accountSid || !authToken || accountSid.trim() === '' || authToken.trim() === '') {
    return null
  }

  return twilio(accountSid, authToken)
}

/**
 * Format phone number to Twilio WhatsApp URI format
 * @param {string} phone
 * @returns {string}
 */
const formatWhatsAppNumber = (phone) => {
  if (!phone) return ''
  const trimmed = String(phone).trim().replace(/^whatsapp:/, '')
  return `whatsapp:${trimmed}`
}

/**
 * Core helper to send a WhatsApp message.
 * In 'development' mode, it mocks sending and logs all details to the console.
 * In 'production' mode, it dispatches via Twilio API.
 *
 * @param {Object} params
 * @param {string} params.to - Recipient phone number
 * @param {string} params.body - Formatted message body
 * @param {string} [params.requestId] - Optional associated visitor request ID
 * @param {string} [params.mediaUrl] - Optional media / photo URL
 * @returns {Promise<Object>}
 */
const sendWhatsAppMessage = async ({ to, body, requestId, mediaUrl }) => {
  if (!to) {
    logger.error('WhatsApp send failed: Recipient phone number is missing.')
    return { success: false, error: 'Recipient phone number (to) is required.' }
  }

  const toFormatted = formatWhatsAppNumber(to)
  const fromRaw = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'
  const fromFormatted = formatWhatsAppNumber(fromRaw)
  const isDev = (process.env.NODE_ENV || 'development').toLowerCase() === 'development'

  // Development Mock — Avoid external API calls
  if (isDev) {
    const mockSid = `MOCK-${Date.now()}`
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    logger.info('📱 [WhatsApp Mock Delivery - Development Mode]')
    logger.info(`   To:         ${toFormatted}`)
    logger.info(`   From:       ${fromFormatted}`)
    if (requestId) {
      logger.info(`   Request ID: ${requestId}`)
    }
    if (mediaUrl) {
      logger.info(`   Media URL:  ${mediaUrl}`)
    }
    logger.info(`   Message Body:\n${body}`)
    logger.info(`   Mock SID:   ${mockSid}`)
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    return {
      success: true,
      messageSid: mockSid,
      mocked: true,
    }
  }

  // Production — Real Twilio Dispatch
  try {
    const client = getTwilioClient()
    if (!client) {
      throw new Error('Twilio credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) are not configured.')
    }

    const messagePayload = {
      from: fromFormatted,
      to: toFormatted,
      body,
    }

    if (mediaUrl && mediaUrl.startsWith('http')) {
      messagePayload.mediaUrl = [mediaUrl]
    }

    const message = await client.messages.create(messagePayload)
    logger.info(`WhatsApp message sent successfully to ${toFormatted} (SID: ${message.sid})`)
    return {
      success: true,
      messageSid: message.sid,
    }
  } catch (error) {
    logger.error(`Failed to send WhatsApp message to ${toFormatted}:`, {
      message: error.message,
      code: error.code,
      status: error.status,
      moreInfo: error.moreInfo,
    })
    return {
      success: false,
      error: error.message,
      code: error.code,
    }
  }
}

/**
 * 1. Send Visitor Alert to Primary Resident
 * @param {Object} params
 * @param {string} params.toPhone
 * @param {string} params.visitorName
 * @param {string} [params.purpose]
 * @param {string} [params.flatNumber]
 * @param {string} [params.societyName]
 * @param {string} [params.requestId]
 * @param {string} [params.photoUrl]
 * @returns {Promise<Object>}
 */
const sendVisitorAlert = async ({
  toPhone,
  visitorName,
  purpose,
  flatNumber,
  societyName,
  requestId,
  photoUrl,
}) => {
  const timeString = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })

  const body = [
    '🔔 *GATEZY — Visitor at Gate*',
    '',
    `🏢 *Society:* ${societyName || 'GATEZY Community'}`,
    `🏠 *Flat:* ${flatNumber || 'N/A'}`,
    `👤 *Visitor:* ${visitorName || 'Guest'}`,
    purpose ? `📦 *Purpose:* ${purpose}` : '',
    `🕒 *Time:* ${timeString}`,
    requestId ? `🔖 *Request ID:* ${requestId}` : '',
    '',
    'Please reply below to approve or deny entry:',
    '👉 *Reply 1 to ALLOW*',
    '👉 *Reply 2 to DENY*',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return await sendWhatsAppMessage({
    to: toPhone,
    body,
    requestId,
    mediaUrl: photoUrl,
  })
}

/**
 * 2. Send Escalation Reminder
 * Step 1 = Gentle reminder, Step 2 = Urgent reminder
 */
const sendReminder = async ({ toPhone, visitorName, step, requestId }) => {
  const isUrgent = Number(step) >= 2

  let body
  if (isUrgent) {
    body = [
      '⚠️ *GATEZY — URGENT Visitor Reminder*',
      '',
      `*${visitorName}* has been waiting at the security gate for over a minute!`,
      requestId ? `🔖 *Request ID:* ${requestId}` : '',
      '',
      'Your immediate response is required:',
      '👉 *Reply 1 to ALLOW*',
      '👉 *Reply 2 to DENY*',
    ]
      .filter((line) => line !== '')
      .join('\n')
  } else {
    body = [
      '⏳ *GATEZY — Visitor Reminder*',
      '',
      `*${visitorName}* is still waiting at the gate for your response.`,
      requestId ? `🔖 *Request ID:* ${requestId}` : '',
      '',
      'Please take a moment to respond:',
      '👉 *Reply 1 to ALLOW*',
      '👉 *Reply 2 to DENY*',
    ]
      .filter((line) => line !== '')
      .join('\n')
  }

  return await sendWhatsAppMessage({
    to: toPhone,
    body,
    requestId,
  })
}

/**
 * 3. Send Notification to Alternate Contact
 */
const sendToAltNumber = async ({ toPhone, visitorName, flatNumber, requestId }) => {
  const body = [
    '👨‍👩‍👧 *GATEZY — Alternate Family Notification*',
    '',
    `A visitor, *${visitorName}*, is waiting at the gate for *Flat ${flatNumber}*.`,
    'The primary contact has not responded to previous alerts.',
    requestId ? `🔖 *Request ID:* ${requestId}` : '',
    '',
    'As a registered member of this flat, please reply:',
    '👉 *Reply 1 to ALLOW*',
    '👉 *Reply 2 to DENY*',
  ]
    .filter((line) => line !== '')
    .join('\n')

  return await sendWhatsAppMessage({
    to: toPhone,
    body,
    requestId,
  })
}

/**
 * 4. Send Decision Confirmation back to Resident
 */
const sendConfirmation = async ({ toPhone, visitorName, decision, requestId }) => {
  const cleanDecision = String(decision).toLowerCase().trim()
  const isAllowed = cleanDecision === 'allow' || cleanDecision === 'allowed' || cleanDecision === '1'

  let body
  if (isAllowed) {
    body = [
      '✅ *GATEZY — Entry Allowed*',
      '',
      `You have *ALLOWED* entry for *${visitorName}*.`,
      'The security guard at the gate has been notified and granted entry.',
    ].join('\n')
  } else {
    body = [
      '⛔ *GATEZY — Entry Denied*',
      '',
      `You have *DENIED* entry for *${visitorName}*.`,
      'The security guard has been notified not to permit entry.',
    ].join('\n')
  }

  return await sendWhatsAppMessage({
    to: toPhone,
    body,
    requestId,
  })
}

/**
 * 5. Send Emergency Override Alert to Society Secretary
 */
const sendAdminAlert = async ({ toPhone, societyName, guardName, emergencyType, requestId }) => {
  const timeString = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })

  const body = [
    '🚨 *GATEZY — EMERGENCY OVERRIDE ALERT*',
    '',
    `🏢 *Society:* ${societyName || 'GATEZY Society'}`,
    `🚑 *Emergency Type:* ${emergencyType ? emergencyType.toUpperCase() : 'EMERGENCY VEHICLE'}`,
    `👮 *Guard on Duty:* ${guardName || 'Gate Security'}`,
    `🕒 *Time:* ${timeString}`,
    '',
    '⚠️ An emergency vehicle has been granted immediate gate bypass entry.',
  ].join('\n')

  return await sendWhatsAppMessage({
    to: toPhone,
    body,
    requestId,
  })
}

/**
 * 6. Send Daily Summary Report to Secretary
 */
const sendDailyReport = async ({
  toPhone,
  societyName,
  date,
  total,
  allowed,
  denied,
  noResponse,
  emergencies,
}) => {
  const reportDate = date || new Date().toISOString().split('T')[0]

  const body = [
    '📊 *GATEZY — Daily Visitor Report*',
    '',
    `🏢 *Society:* ${societyName || 'GATEZY Society'}`,
    `📅 *Date:* ${reportDate}`,
    '',
    '📈 *Activity Summary:*',
    `• *Total Visitors:* ${total || 0}`,
    `• *Allowed Entries:* ${allowed || 0}`,
    `• *Denied Entries:* ${denied || 0}`,
    `• *No Response:* ${noResponse || 0}`,
    `• *Emergency Overrides:* ${emergencies || 0}`,
    '',
    '_GATEZY — Your Gate. Your Control._',
  ].join('\n')

  return await sendWhatsAppMessage({
    to: toPhone,
    body,
  })
}

module.exports = {
  formatWhatsAppNumber,
  sendWhatsAppMessage,
  sendVisitorAlert,
  sendReminder,
  sendToAltNumber,
  sendConfirmation,
  sendAdminAlert,
  sendDailyReport,
}
