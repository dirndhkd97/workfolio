interface Env {
  DB: D1Database;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const { email, code } = await request.json() as { email: string; code: string };

    if (!email || !code) {
      return new Response(JSON.stringify({ error: '이메일과 인증코드를 입력해주세요.' }), { status: 400, headers });
    }

    const record = await env.DB
      .prepare(`SELECT id FROM auth_codes WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`)
      .bind(email, code)
      .first<{ id: number }>();

    if (!record) {
      return new Response(JSON.stringify({ error: '인증코드가 올바르지 않거나 만료되었습니다.' }), { status: 401, headers });
    }

    // 코드 사용 처리
    await env.DB.prepare(`UPDATE auth_codes SET used = 1 WHERE id = ?`).bind(record.id).run();

    // 세션 생성
    const token = crypto.randomUUID();
    await env.DB
      .prepare(`INSERT INTO sessions (token, email, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`)
      .bind(token, email)
      .run();

    // 기존 회원 여부 확인
    const customer = await env.DB
      .prepare(`SELECT id FROM customers WHERE email = ?`)
      .bind(email)
      .first<{ id: number }>();

    const responseHeaders = new Headers(headers);
    responseHeaders.set('Set-Cookie', `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);

    return new Response(JSON.stringify({
      success: true,
      isNewUser: !customer,
    }), { status: 200, headers: responseHeaders });
  } catch (err) {
    console.error('verify-code error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
