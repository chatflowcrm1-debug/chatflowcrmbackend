const findMany = jest.fn();
const createMany = jest.fn();

jest.mock('../src/db/prisma', () => ({
  prisma: { customer: { findMany, createMany } },
}));

import { CUSTOMER_IMPORT_MAX_BYTES, importCustomersFromCsv } from '../src/modules/customers/customer-import';

describe('customer CSV import', () => {
  beforeEach(() => {
    findMany.mockResolvedValue([]);
    createMany.mockResolvedValue({ count: 0 });
    jest.clearAllMocks();
  });

  it('imports supported headers, trims values, and ignores empty rows', async () => {
    const result = await importCustomersFromCsv('org-a', Buffer.from('First Name,Last Name,Email,Phone,Company\n Ada , Lovelace , ada@example.com , +1 555 0100 , Analytical Engines\n,,,,\n'));

    expect(result).toMatchObject({ totalRows: 1, validRows: 1, importedRows: 1, invalidRows: 0, duplicateRows: 0, skippedRows: 0 });
    expect(createMany).toHaveBeenCalledWith({ data: [{ organizationId: 'org-a', name: 'Ada Lovelace', email: 'ada@example.com', phone: '+1 555 0100', company: 'Analytical Engines', source: 'CSV_IMPORT', status: 'ACTIVE' }] });
  });

  it('reports invalid email and duplicate CSV rows without aborting valid rows', async () => {
    const result = await importCustomersFromCsv('org-a', Buffer.from('Name,Email\nAda,ada@example.com\nAda,ada@example.com\nBad,bad-email\n'));

    expect(result).toMatchObject({ totalRows: 3, validRows: 1, importedRows: 1, invalidRows: 1, duplicateRows: 1, skippedRows: 2 });
    expect(result.errors).toEqual(expect.arrayContaining([
      { row: 3, message: 'Duplicate contact in CSV' },
      { row: 4, message: 'Invalid email address' },
    ]));
  });

  it('skips existing contacts within the requested organization', async () => {
    findMany.mockResolvedValue([{ name: 'Ada', email: 'ada@example.com', phone: null }]);
    const result = await importCustomersFromCsv('org-a', Buffer.from('name,email\nAda,ada@example.com\nGrace,grace@example.com\n'), true);

    expect(findMany).toHaveBeenCalledWith({ where: { organizationId: 'org-a' }, select: { name: true, email: true, phone: true } });
    expect(result).toMatchObject({ validRows: 2, importedRows: 0, duplicateRows: 1, skippedRows: 1 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized CSV input', async () => {
    await expect(importCustomersFromCsv('org-a', Buffer.from('name,email\n"Ada,ada@example.com'))).rejects.toThrow('Unclosed quoted field');
    await expect(importCustomersFromCsv('org-a', Buffer.alloc(CUSTOMER_IMPORT_MAX_BYTES + 1))).rejects.toThrow('2 MB limit');
  });
});