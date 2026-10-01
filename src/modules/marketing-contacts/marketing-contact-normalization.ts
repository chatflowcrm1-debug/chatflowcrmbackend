export function normalizeMarketingEmail(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function normalizeMarketingPhone(value?: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits || null;
}

export function isValidMarketingPhone(value?: string | null) {
  if (!value?.trim()) return true;
  if (!/^\+?[0-9\s().-]+$/.test(value.trim())) return false;
  const digits = normalizeMarketingPhone(value);
  return Boolean(digits && digits.length >= 7 && digits.length <= 15);
}

export function normalizeMarketingDisplayValue(value?: string | null) {
  const normalized = value?.trim();
  return normalized || null;
}