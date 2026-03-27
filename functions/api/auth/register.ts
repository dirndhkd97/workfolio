interface Env {
  DB: D1Database;
}

function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const token = getSessionToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: '로그인이 필요합니다.' }), { status: 401, headers });
    }

    const session = await env.DB
      .prepare(`SELECT email FROM sessions WHERE token = ? AND expires_at > datetime('now')`)
      .bind(token)
      .first<{ email: string }>();

    if (!session) {
      return new Response(JSON.stringify({ error: '세션이 만료되었습니다.' }), { status: 401, headers });
    }

    const { name, company, phone } = await request.json() as { name: string; company?: string; phone?: string };

    if (!name) {
      return new Response(JSON.stringify({ error: '이름을 입력해주세요.' }), { status: 400, headers });
    }

    await env.DB
      .prepare(`INSERT INTO customers (email, name, company, phone) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = ?, company = ?, phone = ?`)
      .bind(session.email, name, company || '', phone || '', name, company || '', phone || '')
      .run();

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err) {
    console.error('register error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
