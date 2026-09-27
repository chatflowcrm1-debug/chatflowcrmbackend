export type TriggerEvent = 'NEW_LEAD' | 'LEAD_QUALIFIED' | 'FOLLOW_UP_OVERDUE';

export interface AutomationRule {
  id: string;
  name: string;
  when: TriggerEvent;
  then: string[];
  enabled: boolean;
}

export const AUTOMATION_RULES: AutomationRule[] = [
  { id: 'rule-1', name: 'Assign new leads', when: 'NEW_LEAD', then: ['Assign to sales team'], enabled: true },
  { id: 'rule-2', name: 'Create follow-up for qualified leads', when: 'LEAD_QUALIFIED', then: ['Create follow-up task'], enabled: true },
  { id: 'rule-3', name: 'Notify overdue task owners', when: 'FOLLOW_UP_OVERDUE', then: ['Notify assigned agent'], enabled: true },
];

export function evaluateAutomation(event: TriggerEvent) {
  return AUTOMATION_RULES.filter((rule) => rule.when === event && rule.enabled);
}
