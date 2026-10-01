import { prisma } from '../../db/prisma';
import {
  isValidMarketingPhone,
  normalizeMarketingDisplayValue,
  normalizeMarketingEmail,
  normalizeMarketingPhone,
} from './marketing-contact-normalization';

export const MARKETING_CONTACT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

type CsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

type ImportCandidate = {
  rowNumber: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  normalizedEmail: string | null;
  normalizedPhone: string | null;
};

export type MarketingContactImportError = { row: number; message: string };

export type MarketingContactImportSummary = {
  totalRows: number;
  validRows: number;
  importedRows: number;
  skippedRows: number;
  duplicateRows: number;
  invalidRows: number;
  errors: MarketingContactImportError[];
};

function normalizeHeader(value: string) {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }

  if (quoted) throw new Error('Unclosed quoted field');
  values.push(value.trim());
  return values;
}

function parseCsv(buffer: Buffer): CsvRow[] {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length || !lines[0].trim()) throw new Error('CSV file is empty');

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  if (!headers.some((header) => ['firstname', 'lastname', 'email', 'phone', 'company'].includes(header))) {
    throw new Error('CSV must include a supported contact header');
  }

  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    return {
      rowNumber: index + 2,
      values: Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex] || ''])),
    };
  });
}

function firstValue(values: Record<string, string>, keys: string[]) {
  return keys.map((key) => values[key]?.trim() || '').find(Boolean) || '';
}

function toCandidate(row: CsvRow): ImportCandidate | MarketingContactImportError {
  const firstName = normalizeMarketingDisplayValue(firstValue(row.values, ['firstname']));
  const lastName = normalizeMarketingDisplayValue(firstValue(row.values, ['lastname']));
  const email = normalizeMarketingDisplayValue(firstValue(row.values, ['email']));
  const phone = normalizeMarketingDisplayValue(firstValue(row.values, ['phone']));
  const company = normalizeMarketingDisplayValue(firstValue(row.values, ['company']));

  if (!firstName && !lastName && !email && !phone && !company) {
    return { row: row.rowNumber, message: 'Row has no name, email, phone, or company' };
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { row: row.rowNumber, message: 'Invalid email address' };
  }
  if (phone && !isValidMarketingPhone(phone)) {
    return { row: row.rowNumber, message: 'Invalid phone number' };
  }

  return {
    rowNumber: row.rowNumber,
    firstName,
    lastName,
    email,
    phone,
    company,
    normalizedEmail: normalizeMarketingEmail(email),
    normalizedPhone: normalizeMarketingPhone(phone),
  };
}

function identityKeys(candidate: Pick<ImportCandidate, 'normalizedEmail' | 'normalizedPhone' | 'firstName' | 'lastName' | 'company'>) {
  const contactKeys = [
    ...(candidate.normalizedEmail ? [`email:${candidate.normalizedEmail}`] : []),
    ...(candidate.normalizedPhone ? [`phone:${candidate.normalizedPhone}`] : []),
  ];
  if (contactKeys.length) return contactKeys;
  const name = [candidate.firstName, candidate.lastName, candidate.company].filter(Boolean).join(' ').trim().toLowerCase();
  return name ? [`name:${name}`] : [];
}

export async function importMarketingContactsFromCsv(organizationId: string, buffer: Buffer, preview = false): Promise<MarketingContactImportSummary> {
  if (buffer.length > MARKETING_CONTACT_IMPORT_MAX_BYTES) throw new Error('CSV file exceeds the 2 MB limit');

  const rows = parseCsv(buffer);
  const errors: MarketingContactImportError[] = [];
  const candidates: ImportCandidate[] = [];
  const seenKeys = new Set<string>();
  let totalRows = 0;

  for (const row of rows) {
    if (Object.values(row.values).every((value) => !value.trim())) continue;
    totalRows += 1;
    const candidate = toCandidate(row);
    if ('message' in candidate) {
      errors.push(candidate);
      continue;
    }

    const keys = identityKeys(candidate);
    if (keys.some((key) => seenKeys.has(key))) {
      errors.push({ row: candidate.rowNumber, message: 'Duplicate contact in CSV' });
      continue;
    }
    keys.forEach((key) => seenKeys.add(key));
    candidates.push(candidate);
  }

  const existing = await prisma.marketingContact.findMany({
    where: { organizationId },
    select: { normalizedEmail: true, normalizedPhone: true, firstName: true, lastName: true, company: true },
  });
  const existingKeys = new Set(existing.flatMap((contact) => identityKeys(contact)));
  const newCandidates = candidates.filter((candidate) => {
    const keys = identityKeys(candidate);
    if (keys.some((key) => existingKeys.has(key))) {
      errors.push({ row: candidate.rowNumber, message: 'Marketing contact already exists' });
      return false;
    }
    keys.forEach((key) => existingKeys.add(key));
    return true;
  });

  if (!preview && newCandidates.length) {
    await prisma.marketingContact.createMany({
      data: newCandidates.map((candidate) => ({
        organizationId,
        customerId: null,
        email: candidate.email,
        normalizedEmail: candidate.normalizedEmail,
        phone: candidate.phone,
        normalizedPhone: candidate.normalizedPhone,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        company: candidate.company,
        status: 'ACTIVE',
      })),
    });
  }

  const duplicateRows = errors.filter((error) => error.message.includes('Duplicate') || error.message.includes('already exists')).length;
  const invalidRows = errors.length - duplicateRows;
  return {
    totalRows,
    validRows: candidates.length,
    importedRows: preview ? 0 : newCandidates.length,
    skippedRows: errors.length,
    duplicateRows,
    invalidRows,
    errors,
  };
}