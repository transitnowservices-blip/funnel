// lib/documents.js — Phase 6: document management (spec section 23).
//
// Driver/business/contract document upload + records:
//   document type, uploaded by, date, expiration date where applicable,
//   status, verification status. Sensitive document types are admin-only.
// Files are stored as BLOBs in the database — the same server-side pattern
// the A–L exception-photo flow uses (photo_blob in package_exceptions).
//
// Contract documents (Phase 3 held references only) are wired in here:
// attachContractDocument() stores the file in driver_documents
// (owner_type='contract') and links a contract_documents row to it with
// expiration + verification columns (Phase-6 schema migration).
'use strict';

const path = require('path');
const db = require('./db');

const MAX_FILE_BYTES = 8 * 1024 * 1024; // same cap as the existing upload flows
const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];

const DOC_TYPES = {
  driver_license:      { label: 'Driver license',      sensitive: false },
  vehicle_registration:{ label: 'Vehicle registration', sensitive: false },
  insurance:           { label: 'Insurance',           sensitive: false },
  business_license:    { label: 'Business document',   sensitive: false },
  w9:                  { label: 'W-9',                 sensitive: true  },
  training_cert:       { label: 'Training document',   sensitive: false },
  agreement:           { label: 'Agreement',           sensitive: false },
  contract_document:   { label: 'Contract document',   sensitive: false },
  other:               { label: 'Other',               sensitive: false },
};

const OWNER_TYPES = ['driver', 'lead', 'contract', 'business'];
const DOC_STATUSES = ['pending', 'approved', 'rejected'];
const VERIFICATION_STATUSES = ['unverified', 'verified', 'rejected'];

function str(v, max = 4000) {
  const s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function isSensitive(docType) {
  return !!(DOC_TYPES[docType] && DOC_TYPES[docType].sensitive);
}

/** Role-based access: admin sees everything; a driver sees/downloads only
 *  their own non-sensitive documents. Returns null when denied. */
function canView(doc, { role = '', ownerType = '', ownerId = null } = {}) {
  if (!doc) return false;
  if (role === 'admin') return true;
  if (role !== 'driver') return false;
  if (isSensitive(doc.doc_type)) return false; // sensitive = admin-only
  if (doc.owner_type !== 'driver') return false;
  return Number(doc.owner_id) === Number(ownerId);
}

function validateUpload({ ownerType, docType, file, role }) {
  if (!OWNER_TYPES.includes(ownerType)) throw new Error('Unknown document owner type.');
  if (!DOC_TYPES[docType]) throw new Error('Unknown document type.');
  if (isSensitive(docType) && role !== 'admin') {
    throw new Error('This document type can only be submitted by operations staff. Please contact operations for help.');
  }
  if (!file || !file.buffer || !file.buffer.length) throw new Error('Please choose a file to upload.');
  if (file.buffer.length > MAX_FILE_BYTES) {
    throw new Error(`That file is too large (${(file.buffer.length / 1048576).toFixed(1)} MB). Please keep documents under 8 MB.`);
  }
  const mime = String(file.mime || '').toLowerCase();
  if (!ALLOWED_MIMES.includes(mime)) {
    throw new Error(`That file type (${mime || 'unknown'}) is not accepted. Please upload a PNG, JPG, GIF, WebP image, or a PDF.`);
  }
  const base = path.basename(String(file.originalName || 'document'));
  const safe = base.replace(/[^\w.\-() ]/g, '').trim().slice(0, 120) || 'document';
  return { mime, safeName: safe, size: file.buffer.length };
}

/**
 * Store a document record + file. `file`: { buffer, mime, originalName }.
 * expiresAt: epoch ms or null.
 */
async function uploadDocument({ ownerType, ownerId, docType, file, uploadedBy = '', uploadedByRole = 'admin', expiresAt = null, notes = '' }) {
  const clean = validateUpload({ ownerType, docType, file, role: uploadedByRole });
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO driver_documents
       (owner_type, owner_id, doc_type, file_blob, file_mime, file_name, size_bytes,
        uploaded_by, uploaded_by_role, uploaded_at, expires_at, status, verification_status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unverified', ?)`,
    [
      ownerType, ownerId, docType, file.buffer, clean.mime, clean.safeName, clean.size,
      str(uploadedBy, 120), uploadedByRole, now,
      expiresAt == null ? null : Number(expiresAt),
      str(notes, 4000),
    ]
  );
  return db.get('SELECT * FROM driver_documents WHERE id = ?', [info.lastInsertRowid]);
}

async function getDocument(id) {
  return db.get('SELECT * FROM driver_documents WHERE id = ?', [id]);
}

async function listDocuments({ ownerType = '', ownerId = null, docType = '', status = '' } = {}) {
  const conds = [], params = [];
  if (ownerType) { conds.push('owner_type = ?'); params.push(ownerType); }
  if (ownerId != null && ownerId !== '') { conds.push('owner_id = ?'); params.push(ownerId); }
  if (docType && DOC_TYPES[docType]) { conds.push('doc_type = ?'); params.push(docType); }
  if (status && (DOC_STATUSES.includes(status) || VERIFICATION_STATUSES.includes(status))) {
    conds.push('(status = ? OR verification_status = ?)'); params.push(status, status);
  }
  // Never select file_blob in list queries (blobs are fetched per-document).
  return db.all(
    `SELECT id, owner_type, owner_id, doc_type, file_mime, file_name, size_bytes,
            uploaded_by, uploaded_by_role, uploaded_at, expires_at, status,
            verification_status, verified_by, verified_at, notes
     FROM driver_documents
     ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     ORDER BY uploaded_at DESC, id DESC LIMIT 500`,
    params
  );
}

async function setVerification(id, { status = '', verificationStatus = '', by = 'admin' } = {}) {
  const doc = await getDocument(id);
  if (!doc) throw new Error('Document not found');
  const st = DOC_STATUSES.includes(status) ? status : doc.status;
  const vs = VERIFICATION_STATUSES.includes(verificationStatus) ? verificationStatus : doc.verification_status;
  const now = Date.now();
  await db.run(
    'UPDATE driver_documents SET status = ?, verification_status = ?, verified_by = ?, verified_at = ? WHERE id = ?',
    [st, vs, str(by, 120), now, id]
  );
  // Keep linked contract_documents rows in sync.
  await db.run(
    'UPDATE contract_documents SET verification_status = ?, verified_by = ?, verified_at = ? WHERE document_id = ?',
    [vs, str(by, 120), now, id]
  );
  return getDocument(id);
}

async function deleteDocument(id) {
  const doc = await getDocument(id);
  if (!doc) throw new Error('Document not found');
  await db.run('DELETE FROM driver_documents WHERE id = ?', [id]);
  await db.run('UPDATE contract_documents SET document_id = NULL WHERE document_id = ?', [id]);
}

// --- Contract document wiring --------------------------------------------------
// Phase 3 contract_documents held references only; this gives them real
// upload/verification treatment via the shared documents store.
async function attachContractDocument(contractId, { docType = 'contract_document', file, expiresAt = null, notes = '', by = 'admin', fileName = '' }) {
  const contract = await db.get('SELECT id, contract_number FROM contracts WHERE id = ?', [contractId]);
  if (!contract) throw new Error('Contract not found');
  const type = DOC_TYPES[docType] ? docType : 'contract_document';
  const doc = await uploadDocument({
    ownerType: 'contract', ownerId: contractId, docType: type, file,
    uploadedBy: by, uploadedByRole: 'admin', expiresAt, notes,
  });
  const now = Date.now();
  const info = await db.run(
    `INSERT INTO contract_documents
       (contract_id, doc_type, file_name, notes, uploaded_by, uploaded_at, document_id, expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unverified')`,
    [
      contractId, type, doc.file_name, str(notes, 2000), str(by, 120), now,
      doc.id, expiresAt == null ? null : Number(expiresAt),
    ]
  );
  return db.get('SELECT * FROM contract_documents WHERE id = ?', [info.lastInsertRowid]);
}

/** Contract documents with joined file metadata (no blobs). */
async function listContractDocuments(contractId) {
  return db.all(
    `SELECT c.*, d.file_mime, d.size_bytes, d.status AS doc_status,
            d.verified_by AS doc_verified_by, d.verified_at AS doc_verified_at
     FROM contract_documents c
     LEFT JOIN driver_documents d ON d.id = c.document_id
     WHERE c.contract_id = ? ORDER BY c.uploaded_at DESC, c.id DESC`,
    [contractId]
  );
}

async function getContractDocument(id) {
  return db.get('SELECT * FROM contract_documents WHERE id = ?', [id]);
}

module.exports = {
  MAX_FILE_BYTES,
  ALLOWED_MIMES,
  DOC_TYPES,
  OWNER_TYPES,
  DOC_STATUSES,
  VERIFICATION_STATUSES,
  isSensitive,
  canView,
  uploadDocument,
  getDocument,
  listDocuments,
  setVerification,
  deleteDocument,
  attachContractDocument,
  listContractDocuments,
  getContractDocument,
};
