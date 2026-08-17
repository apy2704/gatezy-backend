// src/utils/seedData.js
require('dotenv').config()
const bcrypt = require('bcrypt')
const db = require('./db')
const logger = require('./logger')

// ─────────────────────────────────────────────────────────────────────────────
// 📱 CONFIGURE TEST RESIDENT WHATSAPP PHONE NUMBER HERE
// ─────────────────────────────────────────────────────────────────────────────
const TEST_RESIDENT_WHATSAPP_PHONE = '+919109494819'

// ─────────────────────────────────────────────────────────────────────────────
// 🎯 TARGET SOCIETY — must match the guard JWT's societyId
// ─────────────────────────────────────────────────────────────────────────────
const TARGET_SOCIETY_ID = 'ef5721d2-1c3f-4181-b2c7-e46eb44ce4af'

async function seedData() {
  logger.info('🌱 Starting database seeding...')

  try {
    // 1. Find the target society by ID (must already exist in DB)
    let society
    const societyCheck = await db.query(
      `SELECT id, name, city, address, secretary_phone FROM societies WHERE id = $1 LIMIT 1`,
      [TARGET_SOCIETY_ID]
    )

    if (societyCheck.rows.length > 0) {
      society = societyCheck.rows[0]
      logger.info(`ℹ️ Using target society: ${society.name} (ID: ${society.id})`)
    } else {
      // Create the target society if it doesn't exist
      const societyInsert = await db.query(
        `INSERT INTO societies (id, name, city, address, total_flats, secretary_phone, plan, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, city, address, secretary_phone`,
        [
          TARGET_SOCIETY_ID,
          'Greenfield Heights',
          'Bangalore',
          'Plot 42, Outer Ring Road, Bellandur, Bangalore',
          120,
          '+919800000001',
          'pro',
          true,
        ]
      )
      society = societyInsert.rows[0]
      logger.info(`✅ Inserted target society: ${society.name} (ID: ${society.id})`)
    }

    // 2. Hash guard PIN (1234)
    const plainPin = '1234'
    const saltRounds = 10
    const pinHash = await bcrypt.hash(plainPin, saltRounds)

    // 3. Create or update test guard
    const guardPhone = '+919876543210'
    let guard
    const guardCheck = await db.query(
      `SELECT id, name, phone, society_id, is_active FROM guards WHERE phone = $1 LIMIT 1`,
      [guardPhone]
    )

    if (guardCheck.rows.length > 0) {
      const guardUpdate = await db.query(
        `UPDATE guards 
         SET society_id = $1, name = $2, pin_hash = $3, is_active = $4 
         WHERE phone = $5 
         RETURNING id, name, phone, society_id, is_active`,
        [society.id, 'Ramesh Kumar (Main Gate)', pinHash, true, guardPhone]
      )
      guard = guardUpdate.rows[0]
      logger.info(`ℹ️ Using guard: ${guard.name} (${guard.phone}) (ID: ${guard.id})`)
    } else {
      const guardInsert = await db.query(
        `INSERT INTO guards (society_id, name, phone, pin_hash, is_active)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, phone, society_id, is_active`,
        [society.id, 'Ramesh Kumar (Main Gate)', guardPhone, pinHash, true]
      )
      guard = guardInsert.rows[0]
      logger.info(`✅ Inserted test guard: ${guard.name} (ID: ${guard.id})`)
    }

    // 4. Create or retrieve Flat 101, Block A, Floor 1
    let flat101
    const flatCheck = await db.query(
      `SELECT id, society_id, flat_number, block, floor, is_occupied
       FROM flats
       WHERE society_id = $1 AND flat_number = $2 AND block = $3
       LIMIT 1`,
      [society.id, '101', 'A']
    )

    if (flatCheck.rows.length > 0) {
      flat101 = flatCheck.rows[0]
      logger.info(`ℹ️ Flat 101-A already exists (ID: ${flat101.id})`)
    } else {
      const flatInsert = await db.query(
        `INSERT INTO flats (society_id, flat_number, block, floor, is_occupied)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id, society_id, flat_number, block, floor, is_occupied`,
        [society.id, '101', 'A', '1']
      )
      flat101 = flatInsert.rows[0]
      logger.info(`✅ Inserted flat: ${flat101.flat_number} Block ${flat101.block} (ID: ${flat101.id})`)
    }

    // 5. Remove any conflicting resident entries for this phone in OTHER flats
    const conflicting = await db.query(
      `SELECT id, flat_id FROM residents WHERE phone = $1 AND flat_id != $2`,
      [TEST_RESIDENT_WHATSAPP_PHONE, flat101.id]
    )
    if (conflicting.rows.length > 0) {
      const conflictIds = conflicting.rows.map(r => r.id)
      // Delete preapprovals that reference these residents (created_by FK)
      await db.query(
        `DELETE FROM preapprovals WHERE created_by = ANY($1::uuid[])`,
        [conflictIds]
      )
      await db.query(
        `DELETE FROM residents WHERE id = ANY($1::uuid[])`,
        [conflictIds]
      )
      logger.info(`🗑️ Deleted ${conflictIds.length} conflicting resident(s) for phone ${TEST_RESIDENT_WHATSAPP_PHONE} in other flats (and their preapprovals)`)
    }

    // 6. Create or update Primary Resident for the target flat
    let resident
    const residentCheck = await db.query(
      `SELECT id, flat_id, name, phone, role, is_primary
       FROM residents
       WHERE flat_id = $1 AND is_primary = TRUE
       LIMIT 1`,
      [flat101.id]
    )

    if (residentCheck.rows.length > 0) {
      const residentUpdate = await db.query(
        `UPDATE residents
         SET name = $1, phone = $2, role = 'owner', is_primary = TRUE
         WHERE id = $3
         RETURNING id, flat_id, name, phone, role, is_primary`,
        ['Test Resident', TEST_RESIDENT_WHATSAPP_PHONE, residentCheck.rows[0].id]
      )
      resident = residentUpdate.rows[0]
      logger.info(`ℹ️ Updated primary resident: ${resident.name} (${resident.phone}) (ID: ${resident.id})`)
    } else {
      const residentInsert = await db.query(
        `INSERT INTO residents (flat_id, name, phone, role, is_primary)
         VALUES ($1, $2, $3, 'owner', TRUE)
         RETURNING id, flat_id, name, phone, role, is_primary`,
        [flat101.id, 'Test Resident', TEST_RESIDENT_WHATSAPP_PHONE]
      )
      resident = residentInsert.rows[0]
      logger.info(`✅ Inserted primary resident: ${resident.name} (${resident.phone}) (ID: ${resident.id})`)
    }

    // 7. Create or update Preapproval for 'Milkman Suresh' (+919111111111, Mon-Sun 6AM-10AM)
    let preapproval
    const milkmanPhone = '+919111111111'
    const preCheck = await db.query(
      `SELECT id, flat_id, visitor_name, visitor_phone, purpose, allowed_days, time_from, time_to, is_active
       FROM preapprovals
       WHERE flat_id = $1 AND visitor_phone = $2
       LIMIT 1`,
      [flat101.id, milkmanPhone]
    )

    if (preCheck.rows.length > 0) {
      const preUpdate = await db.query(
        `UPDATE preapprovals
         SET visitor_name = $1, purpose = 'delivery', allowed_days = 'everyday',
             time_from = '06:00', time_to = '10:00', is_active = TRUE, created_by = $2
         WHERE id = $3
         RETURNING id, flat_id, visitor_name, visitor_phone, purpose, allowed_days, time_from, time_to, is_active`,
        ['Milkman Suresh', resident.id, preCheck.rows[0].id]
      )
      preapproval = preUpdate.rows[0]
      logger.info(`ℹ️ Updated preapproval: ${preapproval.visitor_name} (${preapproval.visitor_phone}) (ID: ${preapproval.id})`)
    } else {
      const preInsert = await db.query(
        `INSERT INTO preapprovals (
           flat_id, created_by, visitor_name, visitor_phone, purpose, allowed_days, time_from, time_to, is_active
         )
         VALUES ($1, $2, $3, $4, 'delivery', 'everyday', '06:00', '10:00', TRUE)
         RETURNING id, flat_id, visitor_name, visitor_phone, purpose, allowed_days, time_from, time_to, is_active`,
        [flat101.id, resident.id, 'Milkman Suresh', milkmanPhone]
      )
      preapproval = preInsert.rows[0]
      logger.info(`✅ Inserted preapproval: ${preapproval.visitor_name} (${preapproval.visitor_phone}) (ID: ${preapproval.id})`)
    }

    // ── Output summary table with all IDs ────────────────────────────────────
    console.log('\n================================================================================')
    console.log('                          GATEZY SEED DATA SUMMARY                             ')
    console.log('================================================================================')
    console.log('🏢 SOCIETY:')
    console.log(`   ID:              ${society.id}`)
    console.log(`   Name:            ${society.name}`)
    console.log(`   City:            ${society.city}`)
    console.log(`   Secretary Phone: ${society.secretary_phone}`)
    console.log('--------------------------------------------------------------------------------')
    console.log('👮 GUARD CREDENTIALS:')
    console.log(`   ID:              ${guard.id}`)
    console.log(`   Name:            ${guard.name}`)
    console.log(`   Phone:           ${guard.phone}`)
    console.log(`   PIN:             ${plainPin} (hashed with bcrypt)`)
    console.log(`   Society ID:      ${guard.society_id}`)
    console.log('--------------------------------------------------------------------------------')
    console.log('🏠 FLAT:')
    console.log(`   ID:              ${flat101.id}`)
    console.log(`   Flat Number:     ${flat101.flat_number}`)
    console.log(`   Block:           ${flat101.block}`)
    console.log(`   Floor:           ${flat101.floor}`)
    console.log('--------------------------------------------------------------------------------')
    console.log('👤 PRIMARY RESIDENT (RECEIVES WHATSAPP ALERTS):')
    console.log(`   ID:              ${resident.id}`)
    console.log(`   Name:            ${resident.name}`)
    console.log(`   Phone:           ${resident.phone}`)
    console.log(`   Is Primary:      ${resident.is_primary}`)
    console.log(`   Flat ID:         ${resident.flat_id}`)
    console.log('--------------------------------------------------------------------------------')
    console.log('🎫 PREAPPROVED VISITOR:')
    console.log(`   ID:              ${preapproval.id}`)
    console.log(`   Visitor Name:    ${preapproval.visitor_name}`)
    console.log(`   Visitor Phone:   ${preapproval.visitor_phone}`)
    console.log(`   Purpose:         ${preapproval.purpose}`)
    console.log(`   Schedule:        ${preapproval.allowed_days} (${preapproval.time_from} - ${preapproval.time_to})`)
    console.log(`   Is Active:       ${preapproval.is_active}`)
    console.log('================================================================================\n')

    logger.info('🎉 Database seeding completed successfully.')
    process.exit(0)
  } catch (err) {
    logger.error('❌ Seeding failed:', err.message)
    console.error(err)
    process.exit(1)
  }
}

seedData()
