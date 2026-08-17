// src/routes/societies.js
const express = require('express')
const router  = express.Router()

router.get('/ping', (req, res) => {
  res.json({ success: true, message: 'Societies route working' })
})

module.exports = router