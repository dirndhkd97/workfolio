interface Env {
  DB: D1Database;
  NCP_ACCESS_KEY: string;
  NCP_SECRET_KEY: string;
  NCP_SMS_SERVICE_ID: string;
}

const ADMIN_PHONE = '07080288696';
const SMS_CALLING_NUMBER = '07080288696';

async function makeSignature(
  method: string,
  url: string,
  timestamp: string,
  accessKey: string,
  secretKey: string,
): Promise<string> {
  const message = `${method} ${url}\n${timestamp}\n${accessKey}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function sendSms(env: Env, to: string, content: string): Promise<void> {
  const timestamp = Date.now().toString();
  const uri = `/sms/v2/services/${env.NCP_SMS_SERVICE_ID}/messages`;
  const signature = await makeSignature('POST', uri, timestamp, env.NCP_ACCESS_KEY, env.NCP_SECRET_KEY);

  await fetch(`https://sens.apigw.ntruss.com${uri}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'x-ncp-apigw-timestamp': timestamp,
      'x-ncp-iam-access-key': env.NCP_ACCESS_KEY,
      'x-ncp-apigw-signature-v2': signature,
    },
    body: JSON.stringify({
      type: 'SMS',
      from: SMS_CALLING_NUMBER,
      content,
      messages: [{ to }],
    }),
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const data = await request.json() as Record<string, string>;
    const { name, phone, email, type, budget, message } = data;

    if (!name || !phone || !email) {
      return new Response(JSON.stringify({ error: '필수 항목을 입력해주세요.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await env.DB
      .prepare(
        'INSERT INTO contacts (name, phone, email, type, budget, message) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .bind(name, phone, email, type || null, budget || null, message || null)
      .run();

    // 관리자에게 SMS 알림
    try {
      const smsContent = `[Workfolio] 새 상담 신청\n${name} / ${phone}\n${type || '미선택'} / ${budget || '미선택'}`;
      await sendSms(env, ADMIN_PHONE, smsContent);
    } catch (smsErr) {
      console.error('SMS send failed:', smsErr);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Contact form error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
