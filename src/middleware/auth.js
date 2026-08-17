// src/middleware/auth.js
const jwt    = require('jsonwebtoken')
const logger = require('../utils/logger')

const authenticateGuard = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied. No token provided.' 
      })
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.guard = decoded
    next()
  } catch (err) {
    logger.warn('Invalid token attempt:', err.message)
    return res.status(401).json({ 
      success: false, 
      message: 'Invalid or expired token.' 
    })
  }
}

const authenticateAdmin = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: 'Access denied.' 
      })
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.role !== 'admin' && decoded.role !== 'secretary') {
      return res.status(403).json({ 
        success: false, 
        message: 'Insufficient permissions.' 
      })
    }

    req.admin = decoded
    next()
  } catch (err) {
    return res.status(401).json({ 
      success: false, 
      message: 'Invalid or expired token.' 
    })
  }
}

module.exports = { authenticateGuard, authenticateAdmin }