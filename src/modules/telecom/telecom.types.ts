export type TelecomCapability = 'voice' | 'sms' | 'mms' | 'fax';
export type TelecomNumberType = 'LOCAL' | 'NATIONAL' | 'TOLL_FREE' | 'MOBILE' | 'VIRTUAL' | 'VANITY';
export type CallDirection = 'INBOUND' | 'OUTBOUND';

export interface NumberSearchInput {
  country: string;
  numberType?: TelecomNumberType;
  areaCode?: string;
  capabilities?: TelecomCapability[];
}

export interface AvailableNumber {
  /** Stable provider resource ID after purchase; search results may use a provider selection token. */
  providerNumberId: string;
  phoneNumber: string;
  country: string;
  numberType: TelecomNumberType;
  areaCode?: string;
  capabilities: TelecomCapability[];
}

export interface PurchasedNumber extends AvailableNumber {
  status: 'ACTIVE';
}

export interface MakeCallInput {
  fromNumber: string;
  toNumber: string;
  recordingEnabled?: boolean;
}

export interface SendSmsInput {
  fromNumber: string;
  toNumber: string;
  body: string;
}

export interface TelecomProvider {
  searchNumbers(input: NumberSearchInput): Promise<AvailableNumber[]>;
  purchaseNumber(providerNumberId: string): Promise<PurchasedNumber>;
  releaseNumber(providerNumberId: string): Promise<void>;
  makeCall(input: MakeCallInput): Promise<{ providerCallId: string; status: string }>;
  answerCall(providerCallId: string): Promise<void>;
  declineCall(providerCallId: string): Promise<void>;
  hangupCall(providerCallId: string): Promise<void>;
  sendSMS(input: SendSmsInput): Promise<{ providerMessageId: string; status: string }>;
}
