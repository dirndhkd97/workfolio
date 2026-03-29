interface Env {
  DB: D1Database;
}

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const { email, password } = await request.json() as { email: string; password: string };

    if (!email || !password) {
      return new Response(JSON.stringify({ error: '이메일과 비밀번호를 입력해주세요.' }), { status: 400, headers });
    }

    const passwordHash = await hashPassword(password);

    const customer = await env.DB
      .prepare(`SELECT id FROM customers WHERE email = ? AND password_hash = ?`)
      .bind(email, passwordHash)
      .first<{ id: number }>();

    if (!customer) {
      return new Response(JSON.stringify({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }), { status: 401, headers });
    }

    // 세션 생성
    const token = crypto.randomUUID();
    await env.DB
      .prepare(`INSERT INTO sessions (token, email, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`)
      .bind(token, email)
      .run();

    const responseHeaders = new Headers(headers);
    responseHeaders.set('Set-Cookie', `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: responseHeaders });
  } catch (err) {
    console.error('login error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
