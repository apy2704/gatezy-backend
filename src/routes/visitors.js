// src/routes/visitors.js
const express = require('express')
const router = express.Router()
const visitorService = require('../services/visitorService')
const { authenticateGuard } = require('../middleware/auth')
const logger = require('../utils/logger')

// ── Health / Ping ────────────────────────────────────────────
router.get('/ping', (req, res) => {
  res.json({ success: true, message: 'Visitors route working' })
})

// ── Create Visitor Request (Protected) ───────────────────────
// POST /api/visitors/request
router.post('/request', authenticateGuard, async (req, res) => {
  try {
    const guardId = req.guard.guardId || req.guard.id
    const societyId = req.guard.societyId || req.guard.society_id
    const {
      visitorName,
      visitorPhone,
      purpose,
      flatNumber,
      block,
      shiftId,
      photoBase64,
    } = req.body

    if (!visitorName || !flatNumber || !purpose) {
      return res.status(400).json({
        success: false,
        message: 'visitorName, flatNumber, and purpose are required.',
      })
    }

    const result = await visitorService.createVisitorRequest({
      societyId,
      guardId,
      shiftId,
      visitorName,
      visitorPhone,
      purpose,
      flatNumber,
      block,
      photoBase64,
    })

    return res.status(201).json(result)
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
      })
    }

    logger.error('Unexpected error creating visitor request:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Internal server error while processing visitor request.',
    })
  }
})

// ── Get Active Visitors Inside Society (Protected) ───────────
// GET /api/visitors/active
router.get('/active', authenticateGuard, async (req, res) => {
  try {
    const societyId = req.guard.societyId || req.guard.society_id

    if (!societyId) {
      return res.status(400).json({
        success: false,
        message: 'Society ID could not be identified from token.',
      })
    }

    const result = await visitorService.getActiveVisitors(societyId)
    return res.status(200).json(result)
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
      })
    }

    logger.error('Unexpected error fetching active visitors:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching active visitors.',
    })
  }
})

// ── Mark Visitor Exit (Protected) ────────────────────────────
// PATCH /api/visitors/:id/exit
router.patch('/:id/exit', authenticateGuard, async (req, res) => {
  try {
    const { id } = req.params
    const societyId = req.guard.societyId || req.guard.society_id

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Visitor request ID is required in URL path.',
      })
    }

    const result = await visitorService.markVisitorExit({
      visitorRequestId: id,
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

    logger.error('Unexpected error marking visitor exit:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Internal server error while marking visitor exit.',
    })
  }
})

// ── Create Emergency Visitor Entry (Protected) ──────────────
// POST /api/visitors/emergency
router.post('/emergency', authenticateGuard, async (req, res) => {
  try {
    const guardId = req.guard.guardId || req.guard.id
    const guardName = req.guard.name
    const societyId = req.guard.societyId || req.guard.society_id
    const { emergencyType, flatNumber, block, shiftId } = req.body

    if (!emergencyType) {
      return res.status(400).json({
        success: false,
        message: 'emergencyType is required (ambulance, police, fire).',
      })
    }

    const result = await visitorService.createEmergencyRequest({
      societyId,
      guardId,
      guardName,
      shiftId,
      emergencyType,
      flatNumber,
      block,
    })

    return res.status(201).json(result)
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
      })
    }

    logger.error('Unexpected error processing emergency entry:', err.message)
    return res.status(500).json({
      success: false,
      message: 'Internal server error while processing emergency entry.',
    })
  }
})

// ── End Guard Shift (Protected) ──────────────────────────────
// POST /api/visitors/shift/end
router.post('/shift/end', authenticateGuard, async (req, res) => {
  try {
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