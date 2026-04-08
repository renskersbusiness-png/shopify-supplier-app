/**
 * services/notifications.js
 * Sends email notifications to suppliers when new line items are assigned to them.
 * Uses nodemailer. Configure SMTP via environment variables.
 */

const nodemailer = require('nodemailer');
const { getSupplierById }        = require('../db/suppliers');
const { getUnnotifiedAssignments, markNotified } = require('../db/assignments');

// ── Transport ─────────────────────────────────────────────────────────────────

function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ── Email builders ────────────────────────────────────────────────────────────

function buildAssignmentEmail(supplier, assignments, appUrl) {
  const portalUrl = `${appUrl}/s/${supplier.access_token}`;
  const itemRows  = assignments.map(a => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eee">${a.title}${a.variant_title ? ` — ${a.variant_title}` : ''}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${a.quantity}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee">${a.sku || '—'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee">${a.shopify_order_num || '—'}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee">${a.customer_name || '—'}</td>
    </tr>
  `).join('');

  const orderCount = new Set(assignments.map(a => a.order_id)).size;
  const itemCount  = assignments.reduce((n, a) => n + a.quantity, 0);

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#222;max-width:700px;margin:0 auto">
  <h2 style="color:#1a1a1a">New items assigned to you</h2>
  <p>Hi ${supplier.name},</p>
  <p>You have <strong>${itemCount} item(s)</strong> across <strong>${orderCount} order(s)</strong> newly assigned to you.</p>

  <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:8px 12px;text-align:left">Product</th>
        <th style="padding:8px 12px">Qty</th>
        <th style="padding:8px 12px;text-align:left">SKU</th>
        <th style="padding:8px 12px;text-align:left">Order #</th>
        <th style="padding:8px 12px;text-align:left">Customer</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <p style="margin-top:24px">
    <a href="${portalUrl}" style="background:#0070f3;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
      View your supplier portal →
    </a>
  </p>
  <p style="color:#888;font-size:12px;margin-top:32px">
    This message was sent because items were assigned to you in the fulfillment system.
    <br>Manage items at: <a href="${portalUrl}">${portalUrl}</a>
  </p>
</body>
</html>`;

  const text = [
    `Hi ${supplier.name},`,
    ``,
    `You have ${itemCount} item(s) across ${orderCount} order(s) newly assigned to you.`,
    ``,
    ...assignments.map(a =>
      `• ${a.title}${a.variant_title ? ` (${a.variant_title})` : ''} x${a.quantity}  —  Order #${a.shopify_order_num || '?'}  —  ${a.customer_name || ''}`
    ),
    ``,
    `Portal: ${portalUrl}`,
  ].join('\n');

  return { html, text };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * notifySupplier(supplierId)
 * Sends one email for all unnotified assigned items for this supplier,
 * then marks them as notified. No-ops if nothing to send or SMTP not configured.
 *
 * Required scopes / env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, APP_URL
 */
async function notifySupplier(supplierId) {
  console.log(`[email] notifySupplier called for supplierId=${supplierId}`);

  if (!process.env.SMTP_HOST) {
    console.log(`[email] skipped → SMTP_HOST not set (configure SMTP env vars to enable email)`);
    return;
  }

  const supplier = getSupplierById(supplierId);
  if (!supplier) {
    console.log(`[email] supplier not found → supplierId=${supplierId}`);
    return;
  }

  if (!supplier.active) {
    console.log(`[email] skipped → supplier "${supplier.name}" (id=${supplierId}) is inactive`);
    return;
  }

  if (!supplier.email) {
    console.log(`[email] skipped → supplier "${supplier.name}" (id=${supplierId}) has no email address`);
    return;
  }

  const assignments = getUnnotifiedAssignments(supplierId);
  if (!assignments.length) {
    console.log(`[email] skipped → no unnotified assignments for supplier "${supplier.name}" (id=${supplierId})`);
    return;
  }

  console.log(`[email] sending to ${supplier.email} — ${assignments.length} unnotified assignment(s) for supplier "${supplier.name}"`);

  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const { html, text } = buildAssignmentEmail(supplier, assignments, appUrl);

  try {
    const transport = createTransport();
    await transport.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      supplier.email,
      subject: `[Fulfillment] ${assignments.length} new item(s) assigned to you`,
      text,
      html,
    });

    markNotified(assignments.map(a => a.id));
    console.log(`[email] sent successfully to ${supplier.email} (${assignments.length} item(s), supplier "${supplier.name}")`);
  } catch (err) {
    console.error(`[email] failed → SMTP error for supplier "${supplier.name}" (${supplier.email}): ${err.message}`);
    console.error(`[email] full error:`, err);
  }
}

/**
 * notifySuppliers(supplierIds)
 * Notify multiple suppliers (e.g. after order assignment).
 */
async function notifySuppliers(supplierIds) {
  for (const id of supplierIds) {
    await notifySupplier(id);
  }
}

module.exports = { notifySupplier, notifySuppliers };
