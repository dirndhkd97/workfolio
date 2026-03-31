interface Env {
  DB: D1Database;
  MAILGUN_API_KEY: string;
}

const MAILGUN_DOMAIN = 'workfolio.life';
const ADMIN_EMAIL = 'contact@workfolio.life';

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

    // 관리자에게 이메일 알림
    try {
      const form = new FormData();
      form.append('from', `Workfolio <noreply@${MAILGUN_DOMAIN}>`);
      form.append('to', ADMIN_EMAIL);
      form.append('subject', `[Workfolio] 새 상담 신청 - ${name}`);
      form.append('html', `
        <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 32px;">
          <h2 style="color: #1a1a2e;">새 상담 신청이 접수되었습니다</h2>
          <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
            <tr><td style="padding: 8px 0; color: #666; width: 80px;">이름</td><td style="padding: 8px 0; font-weight: bold;">${name}</td></tr>
            <tr><td style="padding: 8px 0; color: #666;">연락처</td><td style="padding: 8px 0;">${phone}</td></tr>
            <tr><td style="padding: 8px 0; color: #666;">이메일</td><td style="padding: 8px 0;">${email}</td></tr>
            <tr><td style="padding: 8px 0; color: #666;">유형</td><td style="padding: 8px 0;">${type || '미선택'}</td></tr>
            <tr><td style="padding: 8px 0; color: #666;">예산</td><td style="padding: 8px 0;">${budget || '미선택'}</td></tr>
            ${message ? `<tr><td style="padding: 8px 0; color: #666; vertical-align: top;">설명</td><td style="padding: 8px 0;">${message}</td></tr>` : ''}
          </table>
        </div>
      `);

      await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa('api:' + env.MAILGUN_API_KEY),
        },
        body: form,
      });
    } catch (mailErr) {
      console.error('Admin email notification failed:', mailErr);
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
