// Prints a ready-to-paste agent definition. Does not provision numbers or modify accounts.
const { PUBLIC_BASE_URL, PHONE_BRIDGE_SECRET } = process.env;
if (!PUBLIC_BASE_URL || !/^https:\/\//.test(PUBLIC_BASE_URL) || !/^[a-zA-Z0-9_-]{32,}$/.test(PHONE_BRIDGE_SECRET || '')) {
  console.error('Set PUBLIC_BASE_URL to your HTTPS tunnel origin and PHONE_BRIDGE_SECRET to at least 32 random URL-safe characters in .env. See docs/phone-setup.md.');
  process.exitCode = 1;
} else {
  const origin = new URL(PUBLIC_BASE_URL).origin.replace('https:', 'wss:');
  console.log(JSON.stringify({
    agent_name: 'Stereo Distance — Photon 2.0',
    response_engine: { type: 'custom-llm', llm_websocket_url: `${origin}/api/retell/llm/${PHONE_BRIDGE_SECRET}` },
    voice_id: process.env.RETELL_VOICE_ID || 'retell-Cimo',
    language: 'en-US', max_call_duration_ms: 1200000,
    data_storage_setting: 'basic_attributes_only',
  }, null, 2));
}
