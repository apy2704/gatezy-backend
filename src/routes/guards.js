// src/routes/guards.js
const express = require('express')
const router = express.Router()
const authService = require('../services/authService')
const { authenticateGuard } = require('../middleware/auth')
const logger = require('../utils/logger')

// ── Health / Ping ────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ success: true, message: 'Guards route working' })
})

// ── Guard Login ──────────────────────────────────────────────
// POST /api/guards/login
router.post('/login', async (req, res) => {
  try {
    const { phone, pin } = req.body

    if (!phone || !pin) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and PIN are required.',
      })
    }

    const result = await authService.loginGuard({ phone, pin })
    return res.status(200).json(result)
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
      })
    }

    logger.error('Unexpected error during guard login:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Internal server error during login.',
    })
  }
})

// ── Start Guard Shift (Protected) ────────────────────────────
// POST /api/guards/shift/start
router.post('/shift/start', authenticateGuard, async (req, res) => {
  try {
    const guardId = req.guard.guardId || req.guard.id
    const societyId = req.guard.societyId || req.guard.society_id || req.body?.society_id || req.body?.societyId

    if (!guardId || !societyId) {
      return res.status(400).json({
        success: false,
        message: 'Guard ID and Society ID are required to start a shift.',
      })
    }

    const result = await authService.startShift({ guardId, societyId })
    return res.status(201).json(result)
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
      })
    }

    logger.error('Unexpected error starting shift:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Internal server error while starting shift.',
    })
  }
})

// ── End Guard Shift (Protected) ──────────────────────────────
// POST /api/guards/shift/end
router.post('/shift/end', authenticateGuard, async (req, res) => {
  try {
    const visitorService = require('../services/visitorService')
    const guardId = req.guard.guardId || req.guard.id
    const societyId = req.guard.societyId || req.guard.society_id
    const { shiftId, totalVisitors } = req.body

    if (!shiftId) {
      return res.status(400).json({
        success: false,
        message: 'shiftId is required to end shift.',
      })
    }

    const result = await visitorService.endShift({
      shiftId,
      totalVisitors,
      guardId,
      societyId,
    })

    return res.status(200).json(result)
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
      })
    }

    logger.error('Unexpected error ending shift:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Internal server error while ending shift.',
    })
  }
})

module.exports = router