export function normalizePhone(value) {
  if (typeof value !== 'string') throw new Error('Enter your phone number with a + and country code.');
  const number = value.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(number)) throw new Error('Include + and the country code, for example +1 617 555 0123.');
  return number;
}

// Photon 2.0 supplies the SMS number and SIP trunk; Retell owns the live voice session.
export class RetellClient {
  constructor({ apiKey, agentId, number, fetchImpl = fetch }) {
    Object.assign(this, { apiKey, agentId, number, fetchImpl });
  }
  async request(method, endpoint, body) {
    const response = await this.fetchImpl(`https://api.retellai.com${endpoint}`, {
      method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Retell request failed (${response.status}). Check the API key, agent, and imported Photon number.`);
    return response.status === 204 ? null : response.json();
  }
  createCall(to, sessionId) {
    // Do not retry: creating a call is not idempotent.
    return this.request('POST', '/v2/create-phone-call', {
      from_number: this.number, to_number: to, override_agent_id: this.agentId,
      metadata: { stereo_session: sessionId },
    });
  }
  getCall(id) { return this.request('GET', `/v2/get-call/${encodeURIComponent(id)}`); }
  stopCall(id) { return this.request('POST', `/v2/stop-call/${encodeURIComponent(id)}`); }
  matches(call) {
    return call.call_type === 'phone_call' && call.agent_id === this.agentId &&
      (call.direction === 'inbound' ? call.to_number === this.number : call.direction === 'outbound' && call.from_number === this.number) &&
      ['registered', 'ongoing'].includes(call.call_status);
  }
}
