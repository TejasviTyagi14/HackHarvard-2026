# Photon 2.0 phone setup (Retell)

This integration follows the **Photon 2.0 Beta** hackathon voice path. Photon provides the
SMS number and SIP routing. Retell handles recognition, interruptions, and synthesis. The app
returns its existing deterministic answers from the current browser scene; no LLM guesses distances.

## 1. Run the camera site

Install Node 22+, then run `npm install` and `npm start`. Open http://localhost:8766 and start
cameras or Demo room. Both Measure and Map a building support phone mode.

Copy `.env.example` to `.env`. Never commit `.env`.

## 2. Give the agent a Photon SMS number

In the [Photon dashboard](https://app.photon.codes/dashboard), create/select your **Photon 2.0**
project and add an **SMS number**. Use SMS for the hackathon voice channel.

Open **Voice → Set up default → SIP**. If a profile already exists, use the profile assigned to
that SMS number. Enable inbound with:

- SIP address: `sip:sip.retellai.com;transport=tls` (Photon may normalize this to `sips:sip.retellai.com`).
- Transport: TLS.
- Receiving username and password: leave blank for Retell's standard endpoint.

For callbacks, also enable outbound, choose SHA-256, and securely save the outbound SIP username
and one-time password. Copy the **SIP connection** server and TLS port from your profile.
These SIP credentials go into Retell's number import, not into the app's `.env`.

See the [official Photon 2.0 Retell cookbook](https://photon.codes/docs/beta/cookbooks/voice/retell)
for the current dashboard steps and transport/encryption details.

## 3. Connect Retell to this app

Retell needs a public **WSS** endpoint. Run a tunnel to local port 8766, for example
`ngrok http 8766`, and keep it running. Set `PUBLIC_BASE_URL` in `.env` to its HTTPS origin.
This app exposes only the secret-protected Retell WebSocket through the tunnel; its camera UI,
configuration, and browser control endpoint reject forwarded/public requests. Do not rewrite away
forwarded headers in a reverse proxy. Never tunnel the Python static server: it serves repo files.

Generate a bridge secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `PHONE_BRIDGE_SECRET`. Keep it private; Retell sends no authentication headers on its
Custom LLM WebSocket. The secret URL protects that endpoint, and the server separately retrieves
the call from Retell to verify the configured agent and Photon number before accepting it.

Run `npm run phone:setup`. It prints an agent definition with the exact **Custom LLM URL**.
This command does not create or modify accounts. Treat the printed URL as a credential.

In Retell, create a **Custom LLM** voice agent, choose an available voice, and paste that URL.
Its form is:

```text
wss://YOUR-TUNNEL-HOST/api/retell/llm/YOUR_BRIDGE_SECRET
```

Do not append a call ID: Retell adds `/{call_id}` automatically. Configure the agent for English,
a 20-minute maximum duration, and **basic attributes only** data storage if you do not want Retell
to retain call audio/transcripts. Publish the agent version you intend to use.
The app greets callers and discloses the AI voice through the Custom LLM protocol.

Set `RETELL_API_KEY` and `RETELL_AGENT_ID` in `.env` from this workspace/agent.
No separate OpenAI API key or Photon legacy Voice token is used.

## 4. Import the Photon number into Retell

Retell → **Phone Numbers → + → Connect to your number via SIP trunking**:

- Phone Number: the Photon SMS number, with `+` and country code.
- Termination URI: copy Photon's SIP connection server and TLS port from your Voice profile
  (the official cookbook shows `sip.photon.codes` with TLS port 5061; use your profile's values).
- Transport: TLS.
- Outbound SIP username/password: the credentials generated in Photon, if callbacks are needed.
- Bind the Custom LLM agent and intended published version to **Inbound Call Agent** and,
  for callbacks, **Outbound Call Agent**.

Set `PHOTON_PHONE_NUMBER` in `.env` to that same number. Restart `npm start` after any environment
change. If the tunnel address changes, update the agent's Custom LLM URL and publish as needed.
Retell voice usage is governed by your Retell account; Photon beta access does not configure Retell.

## 5. Verify a real conversation

1. Open the local camera page and start Demo room (or cameras).
2. Press **Connect incoming call** and call the displayed agent number from your phone.
3. Read the six-digit code one digit at a time. The page should show **Connected**.
4. Ask “what is in front of me?”, then “how far is it?” and “what else?”. Check the visible log.
5. Interrupt an answer. The agent should stop and take the new question without opening the laptop mic.
6. Say “use feet” or “calibrate”. For Map a building, try “mark this spot as the kitchen”.
7. Say “goodbye”. Verify the handset and page both end the call.
8. Test **Call my phone** separately to verify outbound SIP credentials and routing.

The automated tests mock Retell and exercise real local HTTP/WebSocket traffic. They do not
prove that your account's SMS number, SIP trunk, selected voice, or external tunnel is configured.
A real inbound and outbound call is the final integration check.

## Troubleshooting

- **Call controls disabled:** fill all four required variables in `.env`: `PHOTON_PHONE_NUMBER`,
  `RETELL_API_KEY`, `RETELL_AGENT_ID`, `PHONE_BRIDGE_SECRET`. The secret must have at least
  32 URL-safe characters. Restart the server.
- **No camera session available:** select Connect incoming call on the intended page before dialing.
  Only one camera page/call can own the bridge at a time.
- **Pairing does not work:** say each digit individually. Three failed attempts end the call.
  Codes expire after five minutes waiting and after 90 seconds on an unpaired call.
- **Retell cannot connect:** confirm the public tunnel is running, the secret matches, the
  configured Custom LLM URL has no call ID, and the correct agent version is published/bound.
- **Inbound call fails before greeting:** check Photon inbound SIP destination, Retell number import,
  inbound agent binding, and allowed inbound countries.
- **Callback fails:** check Photon outbound enabled, SHA-256 SIP credentials, TLS server/port,
  Retell outbound agent binding, and allowed outbound countries. Inspect Retell call history.
- **Browser page stops responding:** the phone gets a clear unavailable message and ends rather than
  receiving stale measurements. Keep the page awake and open. Navigation to another page ends the call.
- **Hangup cannot be confirmed:** end the call on the handset and check the provider connection.

## References

- [Photon 2.0 Retell cookbook](https://photon.codes/docs/beta/cookbooks/voice/retell)
- [Retell Custom LLM setup](https://docs.retellai.com/integrate-llm/setup-websocket-server)
- [Retell WebSocket protocol](https://docs.retellai.com/api-references/llm-websocket)
- [Retell custom telephony](https://docs.retellai.com/deploy/custom-telephony)
