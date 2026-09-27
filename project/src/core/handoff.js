import { getCustomer, setHandoff as setCustomerHandoff } from './customer.js';

export function isHandoffActive(channel, userId) {
  try {
    const customer = getCustomer(channel, userId);
    if (!customer) return false;
    return Boolean(customer.human_handoff);
  } catch {
    return false;
  }
}

export function setHandoff(channel, userId, on, reason) {
  return setCustomerHandoff(channel, userId, on, reason);
}
