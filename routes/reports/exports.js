/**
 * Phase 8.4 — Exports (CSV)
 * Backend-authoritative, owner/manager only (RBAC enforced at reports router level).
 *
 * This module provides:
 *  - CSV serialization helpers
 *
 * No business logic: it only serializes provided rows and metadata.
 */

const CONTENT_TYPE = 'text/csv; charset=utf-8';

const escapeCsv = (value) => {
  if (value === null || value === undefined) return '';

  let str = String(value);

  if (/^[\s]*[=+\-@]/.test(str)) {
    str = "'" + str;
  }

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
};

const toCsv = ({ headers, rows }) => {
  const headerLine = headers.map(escapeCsv).join(',');
  const lines = [headerLine];

  for (const row of rows) {
    const line = headers.map((h) => escapeCsv(row[h])).join(',');
    lines.push(line);
  }

  return lines.join('\n') + '\n';
};

const sanitizeMetaField = (value) => {
  let str;

  try {
    const serialized =
      typeof value === 'string' ? value : JSON.stringify(value);
    str = serialized ?? '';
  } catch {
    str = '';
  }

  str = String(str)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();

  if (/^[=+\-@]/.test(str)) {
    str = "'" + str;
  }

  return str;
};

const toMetaHeader = (meta) => {
  const lines = [];

  const push = (k, v) => {
    const key = sanitizeMetaField(k);
    const value = sanitizeMetaField(v);
    lines.push(`# ${key}: ${value}`);
  };

  for (const [k, v] of Object.entries(meta || {})) {
    push(k, v);
  }

  return lines.length ? lines.join('\n') + '\n' : '';
};

const sanitizeFilename = (filename) =>
  String(filename).replace(/[^A-Za-z0-9._-]+/g, '-');

const setDownloadHeaders = (res, filename) => {
  const safeFilename = sanitizeFilename(filename);

  res.setHeader('Content-Type', CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeFilename}"`
  );
};

module.exports = {
  escapeCsv,
  toCsv,
  toMetaHeader,
  setDownloadHeaders,
};
