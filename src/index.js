require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// Midlertidig lagring av ventende anrop (erstatt med DB i produksjon)
const pendingCalls = {}; // { identity: { callId, callerIdentity, conferenceName, timestamp } }
const pushTokens = {}; // { identity: expoPushToken }

async function sendPushNotification(identity, callId, callerIdentity, conferenceName) {
  const token = pushTokens[identity];
  if (!token) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: token,
        title: 'Innkommende anrop',
        body: `${callerIdentity} ringer`,
        data: { callId, callerIdentity, conferenceName },
        sound: 'default',
        priority: 'high',
        channelId: 'incoming-call',
      }),
    });
  } catch (e) {
    console.warn('Push-varsel feilet:', e.message);
  }
}

// Registrer Expo push token
app.post('/register-push-token', (req, res) => {
  const { identity, pushToken } = req.body;
  if (!identity || !pushToken) return res.status(400).json({ error: 'identity og pushToken påkrevd' });
  pushTokens[identity] = pushToken;
  console.log(`Push token registrert for ${identity}`);
  res.json({ ok: true });
});

// Testside
app.get('/test', (req, res) => res.sendFile(__dirname + '/testcall.html'));

// Twilio Voice JS SDK med globalThis-fix
app.get('/twilio.min.js', (req, res) => {
  const fs = require('fs');
  const sdk = fs.readFileSync(__dirname + '/../node_modules/@twilio/voice-sdk/dist/twilio.min.js', 'utf8');
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`var globalThis = window;\n` + sdk);
});

// Generer Access Token
app.post('/token', (req, res) => {
  const identity = req.body.identity;
  if (!identity) return res.status(400).json({ error: 'identity påkrevd' });

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity }
  );

  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow: true,
    pushCredentialSid: process.env.TWILIO_PUSH_CREDENTIAL_SID,
  }));

  res.json({ token: token.toJwt(), identity });
});

// TwiML: håndterer alle utgående anrop
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to = req.body.To;
  const from = req.body.From?.replace('client:', '') ?? 'ukjent';

  if (to && to.startsWith('client:')) {
    // Anrop til en annen app-bruker → konferanse + polling
    const targetIdentity = to.replace('client:', '');
    const conferenceName = `call_${Date.now()}`;
    const callId = conferenceName;

    pendingCalls[targetIdentity] = {
      callId,
      callerIdentity: from,
      conferenceName,
      timestamp: Date.now(),
    };

    // Send push-varsel til mottaker
    sendPushNotification(targetIdentity, callId, from, conferenceName);

    const dial = twiml.dial();
    dial.conference(conferenceName, {
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      waitUrl: 'https://twimlets.com/holdmusic?Bucket=com.twilio.music.ambient',
    });
  } else if (to && (to.startsWith('+') || to.match(/^\d/))) {
    // Anrop til vanlig telefonnummer (PSTN)
    const dial = twiml.dial({ callerId: process.env.TWILIO_PHONE_NUMBER });
    dial.number(to);
  } else {
    twiml.say({ language: 'nb-NO' }, 'Beklager, kunne ikke koble til.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// App poller dette for innkommende anrop
app.get('/pending-call/:identity', (req, res) => {
  const { identity } = req.params;
  const call = pendingCalls[identity];

  // Rydd opp anrop eldre enn 60 sekunder
  if (call && Date.now() - call.timestamp > 60000) {
    delete pendingCalls[identity];
    return res.json({ hasPendingCall: false });
  }

  res.json({ hasPendingCall: !!call, call: call ?? null });
});

// App svarer på innkommende anrop → blir med i konferansen
app.post('/answer-call', (req, res) => {
  const { identity, callId } = req.body;
  const twiml = new twilio.twiml.VoiceResponse();

  const call = pendingCalls[identity];
  if (!call || call.callId !== callId) {
    twiml.say({ language: 'nb-NO' }, 'Anropet er ikke lenger tilgjengelig.');
    delete pendingCalls[identity];
    return res.type('text/xml').send(twiml.toString());
  }

  delete pendingCalls[identity];

  const dial = twiml.dial();
  dial.conference(call.conferenceName, {
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
  });

  res.type('text/xml').send(twiml.toString());
});

// App avviser anrop
app.post('/reject-call', (req, res) => {
  const { identity } = req.body;
  delete pendingCalls[identity];
  res.json({ ok: true });
});

// Helsesjekk
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend kjører på port ${PORT}`));
