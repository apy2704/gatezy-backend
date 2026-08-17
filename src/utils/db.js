require('dotenv').config()
const { Pool } = require('pg')
const logger = require('./logger')

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  min: parseInt(process.env.DB_POOL_MIN) || 2,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('connect', () => {
  logger.info('New database connection established')
})

pool.on('error', (err) => {
  logger.error('Unexpected database error:', err.message)
})

const query = async (text, params) => {
  const start = Date.now()
  try {
    const result = await pool.query(text, params)
    const duration = Date.now() - start
    logger.debug(`Query executed in ${duration}ms — rows: ${result.rowCount}`)
    return result
  } catch (err) {
    logger.error('Database query failed:', err.message)
    throw err
  }
}

const getClient = async () => {
  const client = await pool.connect()
  const originalQuery = client.query.bind(client)
  const release = client.release.bind(client)
  client.query = (...args) => {
    client.lastQuery = args
    return originalQuery(...args)
  }
  client.release = () => {
    client.query = originalQuery
    client.release = release
    return release()
  }
  return client
}

const transaction = async (callback) => {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error('Transaction rolled back:', err.message)
    throw err
  } finally {
    client.release()
  }
}

// Test connection immediately on startup
const testConnection = async () => {
  try {
    const res = await pool.query('SELECT NOW()')
    logger.info('✅ Database connected:', res.rows[0].now)
  } catch (err) {
    logger.error('❌ Database connection failed:', err.message)
    logger.error('Check your .env DB settings')
  }
}

testConnection()

module.exports = { query, getClient, transaction, pool, testConnection }