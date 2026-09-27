import crypto from 'crypto';
import {
  AvailableNumber,
  MakeCallInput,
  NumberSearchInput,
  PurchasedNumber,
  SendSmsInput,
  TelecomProvider,
} from '../telecom.types';

const inventory: AvailableNumber[] = [
  { providerNumberId: 'mock-us-212-local', phoneNumber: '+12125550101', country: 'US', numberType: 'LOCAL', areaCode: '212', capabilities: ['voice', 'sms'] },
  { providerNumberId: 'mock-us-toll-free', phoneNumber: '+18005550102', country: 'US', numberType: 'TOLL_FREE', capabilities: ['voice', 'sms'] },
  { providerNumberId: 'mock-ca-toll-free', phoneNumber: '+18005550103', country: 'CA', numberType: 'TOLL_FREE', capabilities: ['voice', 'sms'] },
  { providerNumberId: 'mock-gb-local', phoneNumber: '+44205550104', country: 'GB', numberType: 'LOCAL', capabilities: ['voice', 'sms'] },
  { providerNumberId: 'mock-de-national', phoneNumber: '+49305550105', country: 'DE', numberType: 'NATIONAL', capabilities: ['voice', 'sms'] },
  { providerNumberId: 'mock-kr-local', phoneNumber: '+8225550106', country: 'KR', numberType: 'LOCAL', capabilities: ['voice', 'sms'] },
  { providerNumberId: 'mock-cn-local', phoneNumber: '+86215550107', country: 'CN', numberType: 'LOCAL', capabilities: ['voice', 'sms'] },
];

export class MockTelecomProvider implements TelecomProvider {
  async searchNumbers(input: NumberSearchInput) {
    return inventory.filter((number) => (
      number.country === input.country
      && (!input.numberType || number.numberType === input.numberType)
      && (!input.areaCode || number.areaCode === input.areaCode)
      && (!input.capabilities?.length || input.capabilities.every((capability) => number.capabilities.includes(capability)))
    ));
  }

  async purchaseNumber(providerNumberId: string): Promise<PurchasedNumber> {
    const number = inventory.find((item) => item.providerNumberId === providerNumberId);
    if (!number) throw new Error('Number is not available');
    return { ...number, providerNumberId: `mock-allocation-${crypto.randomUUID()}`, status: 'ACTIVE' };
  }

  async releaseNumber(_providerNumberId: string) {
    return;
  }

  async makeCall(_input: MakeCallInput) {
    return { providerCallId: `mock-call-${Date.now()}`, status: 'INITIATED' };
  }

  async hangupCall(_providerCallId: string) {
    return;
  }

  async answerCall(_providerCallId: string) {
    return;
  }

  async declineCall(_providerCallId: string) {
    return;
  }

  async sendSMS(_input: SendSmsInput) {
    return { providerMessageId: `mock-message-${Date.now()}`, status: 'QUEUED' };
  }
}
