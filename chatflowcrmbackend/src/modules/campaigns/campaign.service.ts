export type CampaignChannel = 'EMAIL' | 'SMS';

export interface CampaignDeliveryProvider {
  sendEmail(input: { destination: string; subject: string; content: string }): Promise<{ status: 'MOCKED' }>;
  sendSms(input: { destination: string; content: string }): Promise<{ status: 'MOCKED' }>;
}

export class MockCampaignProvider implements CampaignDeliveryProvider {
  async sendEmail(_input: { destination: string; subject: string; content: string }) {
    return { status: 'MOCKED' as const };
  }

  async sendSms(_input: { destination: string; content: string }) {
    return { status: 'MOCKED' as const };
  }
}

export const campaignDeliveryProvider = new MockCampaignProvider();
