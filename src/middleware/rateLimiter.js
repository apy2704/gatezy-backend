// src/middleware/rateLimiter.js
const rateLimit = {}

const createRateLimiter = (maxRequests = 100, windowMs = 60000) => {
  return (req, res, next) => {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown'
    const now = Date.now()

    if (!rateLimit[key]) {
      rateLimit[key] = { count: 1, resetAt: now + windowMs }
      return next()
    }

    if (now > rateLimit[key].resetAt) {
      rateLimit[key] = { count: 1, resetAt: now + windowMs }
      return next()
    }

    rateLimit[key].count++

    if (rateLimit[key].count > maxRequests) {
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please slow down.',
        retryAfter: Math.ceil((rateLimit[key].resetAt - now) / 1000)
      })
    }

    next()
  }
}

setInterval(() => {
  const now = Date.now()
  Object.keys(rateLimit).forEach(key => {
    if (now > rateLimit[key].resetAt) delete rateLimit[key]
  })
}, 300000)

module.exports = { createRateLimiter }