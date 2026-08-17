// src/utils/redis.js
const Bull  = require('bull')
const logger = require('./logger')

const redisConfig = {
  host:     process.env.REDIS_HOST || 'localhost',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
}

// Create the escalation job queue
const escalationQueue = new Bull('escalation', { redis: redisConfig })

escalationQueue.on('error', (err) => {
  logger.error('Escalation queue error:', err.message)
})

escalationQueue.on('failed', (job, err) => {
  logger.error(`Escalation job ${job.id} failed:`, err.message)
})

escalationQueue.on('completed', (job) => {
  logger.info(`Escalation job ${job.id} completed`)
})

module.exports = { escalationQueue, redisConfig }