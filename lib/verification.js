// Verification reminder emails (Davena-designed 2026-10-07).
// Tells a member exactly which verification documents are still missing,
// with their upload link. Nothing sends without Davena's explicit action
// in /admin/verification (per-driver Remind button or Remind-all).
const { sendEmail } = require('./email');
const drivers = require('./drivers');
const documentsLib = require('./documents');

const CORE = [
  { key: 'driver_license', label: 'Driver license (your ID)' },
  { key: 'ssn_card', label: 'Social Security card' },
  { key: 'vehicle_registration', label: 'Vehicle registration' },
  { key: 'insurance', label: 'Insurance card (must show 100/300/100)' },
  { key: 'training_cert', label: 'Training certificates (HIPAA + bloodborne pathogens)' },
];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function missingForDriver(driverId) {
  const docs = await documentsLib.listDocuments({ ownerType: 'driver', ownerId: Number(driverId) });
  const have = {};
  for (const d of docs) have[d.doc_type] = (have[d.doc_type] || 0) + 1;
  return CORE.filter((c) => !(have[c.key] > 0));
}

// Exact email text approved by Davena 2026-10-07. Do not reword without her.
function reminderHtml(driver, missing) {
  const items = missing.map((m) => `<li>${esc(m.label)}</li>`).join('');
  const uploadUrl = drivers.driverDashUrl(driver.access_token) + '/documents';
  const first = esc((driver.full_name || '').split(' ')[0] || 'there');
  return `<p>Hi ${first},</p>
<p>You're <strong>${missing.length} upload${missing.length === 1 ? '' : 's'} away</strong> from a complete TransitNow verification. Here's exactly what's still needed:</p>
<ul>${items}</ul>
<p><a href="${esc(uploadUrl)}" style="display:inline-block;padding:12px 24px;background:#12263f;color:#fff;text-decoration:none;border-radius:6px;font-weight:700">Upload my documents</a></p>
<p>Companies check this before they approve you — a complete profile gets your applications taken seriously.</p>
<p>Stuck on a step? Reply to this email and tell us what's going on.</p>
<p>— TransitNow</p>
<p style="color:#888;font-size:12px">Application guidance and hiring intel only — TransitNow does not promise or guarantee routes, loads, contracts, work, hiring, earnings, or income.</p>`;
}

async function sendReminder(driverId) {
  const driver = await drivers.getDriverById(driverId);
  if (!driver) throw new Error('Driver not found.');
  if (!driver.email) throw new Error('Driver has no email address.');
  const missing = await missingForDriver(driverId);
  if (!missing.length) return { sent: false, reason: 'already complete' };
  await sendEmail({
    to: driver.email,
    subject: `You're ${missing.length} upload${missing.length === 1 ? '' : 's'} away from verified — TransitNow`,
    html: reminderHtml(driver, missing),
    fromName: 'TransitNow Logistics Services',
  });
  return { sent: true, to: driver.email, missing: missing.map((m) => m.label) };
}

module.exports = { missingForDriver, sendReminder, reminderHtml, CORE };
