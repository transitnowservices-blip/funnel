'use strict';
/**
 * lib/multipart.js — minimal multipart/form-data parser (node built-ins only).
 *
 * Supports a single file field plus regular text fields. Used for the weekly
 * "Proof of Progress" upload. Not a general-purpose parser: it buffers the
 * whole body in memory (routes set a small express.raw() limit first).
 *
 * parseMultipart(req, { maxFileBytes, allowedMimes }) ->
 *   { fields: {name: value}, file: { originalName, mime, size, buffer } | null }
 *
 * Throws an Error with a human-readable message on malformed input,
 * oversized files, or disallowed MIME types.
 */
const path = require('path');

function parseMultipart(req, { maxFileBytes = 8 * 1024 * 1024, allowedMimes = [] } = {}) {
  const contentType = String(req.headers['content-type'] || '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('Expected a multipart form submission.');
  const boundary = `--${(m[1] || m[2]).trim()}`;

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!raw.length) throw new Error('The form arrived empty — please try again.');

  // Split on the boundary. Use latin1 so byte offsets line up 1:1.
  const text = raw.toString('latin1');
  const parts = text.split(boundary);
  const fields = {};
  let file = null;

  for (let part of parts) {
    // First chunk is preamble, last is epilogue ("--").
    if (!part || part === '--' || part === '--\r\n' || part.trim() === '--') continue;
    // Strip leading CRLF and trailing CRLF/--.
    part = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    if (part === '--' || part === '') continue;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = part.slice(0, headerEnd);
    let bodyText = part.slice(headerEnd + 4); // latin1 == byte offsets

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    if (fileMatch && fileMatch[1] !== '') {
      if (file) throw new Error('Only one file can be uploaded at a time.');
      const mimeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headerText);
      const mime = (mimeMatch ? mimeMatch[1] : 'application/octet-stream').trim().toLowerCase();
      if (allowedMimes.length && !allowedMimes.includes(mime)) {
        throw new Error(`That file type (${mime || 'unknown'}) is not accepted. Please upload a PNG, JPG, GIF, WebP image, or a PDF.`);
      }
      const buffer = Buffer.from(bodyText, 'latin1');
      if (buffer.length > maxFileBytes) {
        throw new Error(`That file is too large (${(buffer.length / 1048576).toFixed(1)} MB). Please keep proof uploads under ${(maxFileBytes / 1048576).toFixed(0)} MB.`);
      }
      // Sanitize: strip any path, collapse whitespace, cap length.
      const base = path.basename(String(fileMatch[1]));
      const safe = base.replace(/[^\w.\-() ]/g, '').trim().slice(0, 80) || 'proof';
      file = { originalName: safe, mime, size: buffer.length, buffer };
    } else {
      fields[fieldName] = Buffer.from(bodyText, 'latin1').toString('utf8');
    }
  }
  return { fields, file };
}

module.exports = { parseMultipart };
