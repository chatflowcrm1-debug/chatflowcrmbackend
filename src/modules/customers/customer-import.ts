import { prisma } from '../../db/prisma';

export const CUSTOMER_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

type CsvRow = {
  rowNumber: number;
  values: Record<string, string>;
};

export type CustomerImportError = {
  row: number;
  message: string;
};

export type CustomerImportSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  importedRows: number;
  skippedRows: number;
  errors: CustomerImportError[];
};

type ImportCandidate = {
  rowNumber: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
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

function parseCsv(buffer: Buffer): { headers: string[]; rows: CsvRow[] } {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0 || lines[0].trim() === '') throw new Error('CSV file is empty');

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  if (!headers.some((header) => ['name', 'firstname', 'lastname', 'email', 'phone', 'company'].includes(header))) {
    throw new Error('CSV must include a supported contact header');
  }

  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    return {
      rowNumber: index + 2,
      values: Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex] || ''])),
    };
  });

  return { headers, rows };
}

function firstValue(values: Record<string, string>, keys: string[]) {
  return keys.map((key) => values[key]?.trim() || '').find(Boolean) || '';
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function duplicateKey(candidate: Pick<ImportCandidate, 'name' | 'email' | 'phone'>) {
  if (candidate.email) return `email:${candidate.email.toLowerCase()}`;
  if (candidate.phone) return `phone:${candidate.phone.replace(/\D/g, '')}`;
  return `name:${candidate.name.toLowerCase()}`;
}

function toCandidate(row: CsvRow): ImportCandidate | CustomerImportError {
  const firstName = firstValue(row.values, ['firstname']);
  const lastName = firstValue(row.values, ['lastname']);
  const name = firstValue(row.values, ['name']) || [firstName, lastName].filter(Boolean).join(' ');
  const email = firstValue(row.values, ['email']);
  const phone = firstValue(row.values, ['phone']);
  const company = firstValue(row.values, ['company']);

  if (!name && !email && !phone) return { row: row.rowNumber, message: 'Row has no name, email, or phone' };
  if (email && !isValidEmail(email)) return { row: row.rowNumber, message: 'Invalid email address' };

  return {
    rowNumber: row.rowNumber,
    name: name || email || phone,
    email: email || null,
    phone: phone || null,
    company: company || null,
  };
}

export async function importCustomersFromCsv(organizationId: string, buffer: Buffer, preview = false): Promise<CustomerImportSummary> {
  if (buffer.length > CUSTOMER_IMPORT_MAX_BYTES) throw new Error('CSV file exceeds the 2 MB limit');

  const parsed = parseCsv(buffer);
  const errors: CustomerImportError[] = [];
  const candidates: ImportCandidate[] = [];
  const seen = new Set<string>();

  for (const row of parsed.rows) {
    if (Object.values(row.values).every((value) => !value.trim())) continue;
    const candidate = toCandidate(row);
    if ('message' in candidate) {
      errors.push(candidate);
      continue;
    }

    const key = duplicateKey(candidate);
    if (seen.has(key)) {
      errors.push({ row: row.rowNumber, message: 'Duplicate contact in CSV' });
      continue;
    }
    seen.add(key);
    candidates.push(candidate);
  }

  const existing = await prisma.customer.findMany({
    where: { organizationId },
    select: { name: true, email: true, phone: true },
  });
  const existingKeys = new Set(existing.map((customer) => duplicateKey({ name: customer.name, email: customer.email, phone: customer.phone })));
  const newCandidates = candidates.filter((candidate) => {
    const key = duplicateKey(candidate);
    if (existingKeys.has(key)) {
      errors.push({ row: candidate.rowNumber, message: 'Customer already exists' });
      return false;
    }
    existingKeys.add(key);
    return true;
  });

  if (!preview && newCandidates.length > 0) {
    await prisma.customer.createMany({
      data: newCandidates.map(({ name, email, phone, company }) => ({
        organizationId,
        name,
        email,
        phone,
        company,
        source: 'CSV_IMPORT',
        status: 'ACTIVE',
      })),
    });
  }

  const invalidRows = errors.filter((error) => error.message !== 'Duplicate contact in CSV' && error.message !== 'Customer already exists').length;
  const duplicateRows = errors.length - invalidRows;
  return {
    totalRows: parsed.rows.filter((row) => Object.values(row.values).some((value) => value.trim())).length,
    validRows: candidates.length,
    invalidRows,
    duplicateRows,
    importedRows: preview ? 0 : newCandidates.length,
    skippedRows: errors.length,
    errors,
  };
}