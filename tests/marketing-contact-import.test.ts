const mockMarketingContactFindMany = jest.fn();
const mockMarketingContactCreateMany = jest.fn();
const mockCustomerCreateMany = jest.fn();

jest.mock('../src/db/prisma', () => ({
  prisma: {
    marketingContact: { findMany: mockMarketingContactFindMany, createMany: mockMarketingContactCreateMany },
    customer: { createMany: mockCustomerCreateMany },
  },
}));

import { importMarketingContactsFromCsv, MARKETING_CONTACT_IMPORT_MAX_BYTES } from '../src/modules/marketing-contacts/marketing-contact-import';

describe('marketing contact CSV import', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMarketingContactFindMany.mockResolvedValue([]);
    mockMarketingContactCreateMany.mockResolvedValue({ count: 0 });
  });

  it('previews email-only, phone-only, and combined contact rows without writing', async () => {
    const csv = '\uFEFFFirst Name,Last Name,Email,Phone,Company\nAda,Lovelace,ada@example.com,,Analytical Engines\nGrace,Hopper,,+1 (212) 555-0100,Compiler Co\nKatherine,Johnson,kj@example.com,+1 212 555 0101,NASA';
    const result = await importMarketingContactsFromCsv('org-a', Buffer.from(csv), true);
    expect(result).toMatchObject({ totalRows: 3, validRows: 3, importedRows: 0, skippedRows: 0, duplicateRows: 0 });
    expect(mockMarketingContactCreateMany).not.toHaveBeenCalled();
    expect(mockCustomerCreateMany).not.toHaveBeenCalled();
  });

  it('imports first/last/company and retains display values while storing normalized values', async () => {
    const result = await importMarketingContactsFromCsv('org-a', Buffer.from('First Name,Last Name,Email,Phone,Company\n Ada , Lovelace , Ada@Example.com , +1 (212) 555-0100 , "Engine, ""Works"""'));
    expect(result).toMatchObject({ importedRows: 1, duplicateRows: 0, invalidRows: 0 });
    expect(mockMarketingContactCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        organizationId: 'org-a',
        customerId: null,
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'Ada@Example.com',
        normalizedEmail: 'ada@example.com',
        phone: '+1 (212) 555-0100',
        normalizedPhone: '12125550100',
        company: 'Engine, "Works"',
        status: 'ACTIVE',
      })],
    });
    expect(mockCustomerCreateMany).not.toHaveBeenCalled();
  });

  it('checks both email and phone for duplicate conflicts', async () => {
    mockMarketingContactFindMany.mockResolvedValue([{ normalizedEmail: 'known@example.com', normalizedPhone: '12125550103' }]);
    const csv = [
      'First Name,Last Name,Email,Phone,Company',
      'One,Person,one@example.com,+1 212 555 0100,One Co',
      'Two,Person,two@example.com,+1 212 555 0100,Two Co',
      'Three,Person,one@example.com,+1 646 555 0100,Three Co',
      'Four,Person,four@example.com,+1 212 555 0103,Four Co',
    ].join('\n');
    const result = await importMarketingContactsFromCsv('org-a', Buffer.from(csv));
    expect(result).toMatchObject({ totalRows: 4, validRows: 2, importedRows: 1, duplicateRows: 3, skippedRows: 3 });
    expect(result.errors).toEqual(expect.arrayContaining([
      { row: 3, message: 'Duplicate contact in CSV' },
      { row: 4, message: 'Duplicate contact in CSV' },
      { row: 5, message: 'Marketing contact already exists' },
    ]));
    expect(mockMarketingContactCreateMany).toHaveBeenCalledTimes(1);
  });

  it('detects escaped quoted fields, blank rows, invalid values, and malformed quoting', async () => {
    const result = await importMarketingContactsFromCsv('org-a', Buffer.from('First Name,Last Name,Email,Phone,Company\nAda,,bad-email,,Company\nGrace,,,+--,Company\n,, , , \n'));
    expect(result).toMatchObject({ totalRows: 2, invalidRows: 2, importedRows: 0 });
    await expect(importMarketingContactsFromCsv('org-a', Buffer.from('email\n"unterminated'))).rejects.toThrow('Unclosed quoted field');
  });

  it('rejects files over the 2 MB limit', async () => {
    await expect(importMarketingContactsFromCsv('org-a', Buffer.alloc(MARKETING_CONTACT_IMPORT_MAX_BYTES + 1))).rejects.toThrow('2 MB limit');
  });
});