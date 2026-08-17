// src/index.js - Entry point
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const logger = require('./utils/logger')
const db = require('./utils/db')
const { createRateLimiter } = require('./middleware/rateLimiter')

// Route imports
const guardRoutes = require('./routes/guards')
const visitorRoutes = require('./routes/visitors')
const societyRoutes = require('./routes/societies')
const webhookRoutes = require('./routes/webhooks')

// Job processor — starts listening for escalation jobs
require('./jobs/escalationJob')

const app = express()
const PORT = process.env.PORT || 3000

// ── Security middleware ──────────────────────────────────────
app.use(helmet())
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? ['https://admin.gatezy.in']
        : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}))

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }))       // for base64 photos
app.use(express.urlencoded({ extended: true }))

// ── Rate limiting ─────────────────────────────────────────────
app.use('/api/', createRateLimiter(100, 60000)) // 100 req/min per IP

// ── Health check — always public ─────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'GATEZY Backend',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    })
})

// ── API Routes ───────────────────────────────────────────────
app.use('/api/guards', guardRoutes)
app.use('/api/visitors', visitorRoutes)
app.use('/api/societies', societyRoutes)
app.use('/api/webhooks', webhookRoutes)

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: `Route ${req.method} ${req.path} not found`
    })
})

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err.message)
    res.status(500).json({
        success: false,
        message: process.env.NODE_ENV === 'production'
            ? 'Something went wrong.'
            : err.message
    })
})

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
    logger.info(`GATEZY backend running on port ${PORT}`)
    logger.info(`Environment: ${process.env.NODE_ENV}`)
    logger.info(`Health check: http://localhost:${PORT}/health`)
})

module.exports = app