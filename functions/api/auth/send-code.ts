interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const { email } = await request.json() as { email: string };

    if (!email) {
      return new Response(JSON.stringify({ error: '이메일을 입력해주세요.' }), { status: 400, headers });
    }

    // 시간당 5회 제한
    const recent = await env.DB
      .prepare(`SELECT COUNT(*) as cnt FROM auth_codes WHERE email = ? AND created_at > datetime('now', '-1 hour')`)
      .bind(email)
      .first<{ cnt: number }>();

    if (recent && recent.cnt >= 5) {
      return new Response(JSON.stringify({ error: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.' }), { status: 429, headers });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    await env.DB
      .prepare(`INSERT INTO auth_codes (email, code, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))`)
      .bind(email, code)
      .run();

    // Resend로 이메일 발송
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Workfolio <noreply@workfolio.life>',
        to: [email],
        subject: '[Workfolio] 인증코드 안내',
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
            <h2 style="color: #1a1a2e;">Workfolio 인증코드</h2>
            <p style="color: #666; font-size: 14px;">아래 인증코드를 입력해주세요. (10분간 유효)</p>
            <div style="background: #f4f4f8; border-radius: 8px; padding: 24px; text-align: center; margin: 24px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #6366f1;">${code}</span>
            </div>
            <p style="color: #999; font-size: 12px;">본인이 요청하지 않았다면 이 메일을 무시해주세요.</p>
          </div>
        `,
      }),
    });

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err) {
    console.error('send-code error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
