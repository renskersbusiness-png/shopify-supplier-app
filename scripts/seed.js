#!/usr/bin/env node
/**
 * scripts/seed.js
 * Idempotent seed script — creates suppliers and assignment rules in the DB
 * if they don't already exist. Safe to run multiple times (checks before inserting).
 *
 * Usage:
 *   node scripts/seed.js
 *
 * Run this ONCE after each Railway deploy that uses a fresh DB, OR
 * — better — configure a Railway Volume so the DB persists across deploys.
 *
 * See: https://docs.railway.app/guides/volumes
 */

require('dotenv').config();

const { getDb } = require('../src/db/connection');
const { createSupplier, getAllSuppliers } = require('../src/db/suppliers');
const { getAllRules, createRule } = require('../src/db/assignments');

const db = getDb();

// ── Suppliers to seed ─────────────────────────────────────────────────────────
// Add your real suppliers here. Each will only be inserted if no supplier with
// that exact email already exists. Tokens are generated fresh (UUID) on insert.
//
// IMPORTANT: If you already have suppliers in the DB, their tokens will NOT be
// changed by this script. Only truly new suppliers get new tokens.

const SUPPLIERS_TO_SEED = [
  // {
  //   name:  'Your Real Supplier Name',
  //   email: 'supplier@example.com',
  //   notes: 'Optional notes',
  // },
];

// ── Assignment rules to seed ──────────────────────────────────────────────────
// Rules are matched by (rule_type + rule_value + supplier email). Only inserted
// if a rule with the same type+value doesn't already exist.
//
// rule_type: 'sku' | 'vendor' | 'product_id' | 'order_tag'

const RULES_TO_SEED = [
  // {
  //   supplierEmail: 'supplier@example.com',  // must match a supplier above or already in DB
  //   rule_type:     'vendor',
  //   rule_value:    'Your Vendor Name',
  //   priority:      10,
  // },
];

// ── Run ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log('[Seed] Starting...\n');

  // -- Suppliers
  const existingSuppliers = getAllSuppliers();
  const existingEmails    = new Set(existingSuppliers.map(s => s.email.toLowerCase()));

  for (const s of SUPPLIERS_TO_SEED) {
    if (existingEmails.has(s.email.toLowerCase())) {
      console.log(`[Seed] Supplier "${s.name}" (${s.email}) already exists — skipping`);
      continue;
    }
    const result = createSupplier(s);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
    console.log(`[Seed] Created supplier: ${supplier.name}`);
    console.log(`       Portal link: ${process.env.APP_URL || 'http://localhost:3000'}/s/${supplier.access_token}\n`);
  }

  // -- Rules
  const allSuppliers = getAllSuppliers();
  const supplierByEmail = Object.fromEntries(allSuppliers.map(s => [s.email.toLowerCase(), s]));
  const existingRules   = getAllRules();

  for (const r of RULES_TO_SEED) {
    const supplier = supplierByEmail[r.supplierEmail?.toLowerCase()];
    if (!supplier) {
      console.warn(`[Seed] WARNING: No supplier with email "${r.supplierEmail}" — skipping rule ${r.rule_type}:${r.rule_value}`);
      continue;
    }

    const duplicate = existingRules.find(
      x => x.rule_type === r.rule_type && x.rule_value.toLowerCase() === r.rule_value.toLowerCase()
    );
    if (duplicate) {
      console.log(`[Seed] Rule ${r.rule_type}:${r.rule_value} already exists — skipping`);
      continue;
    }

    createRule({ rule_type: r.rule_type, rule_value: r.rule_value, supplier_id: supplier.id, priority: r.priority || 100 });
    console.log(`[Seed] Created rule: ${r.rule_type} = "${r.rule_value}" → ${supplier.name}`);
  }

  // -- Summary
  console.log('\n[Seed] Done.\n');
  console.log('Current suppliers:');
  for (const s of getAllSuppliers()) {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    console.log(`  [${s.active ? 'active' : 'inactive'}] ${s.name} <${s.email}>`);
    console.log(`           Portal: ${appUrl}/s/${s.access_token}`);
  }
  console.log('\nCurrent rules:');
  for (const r of getAllRules()) {
    console.log(`  [P${r.priority}] ${r.rule_type} = "${r.rule_value}" → ${r.supplier_name}`);
  }
}

run().catch(err => {
  console.error('[Seed] Error:', err.message);
  process.exit(1);
});
