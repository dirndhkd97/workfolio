interface Env {
  DB: D1Database;
}

function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
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

    const customer = await env.DB
      .prepare(`SELECT * FROM customers WHERE email = ?`)
      .bind(session.email)
      .first();

    const subscriptions = await env.DB
      .prepare(`SELECT * FROM subscriptions WHERE customer_email = ? ORDER BY created_at DESC`)
      .bind(session.email)
      .all();

    const payments = await env.DB
      .prepare(`SELECT * FROM payments WHERE customer_key IN (SELECT customer_key FROM subscriptions WHERE customer_email = ?) ORDER BY created_at DESC LIMIT 20`)
      .bind(session.email)
      .all();

    return new Response(JSON.stringify({
      email: session.email,
      customer: customer || null,
      subscriptions: subscriptions.results || [],
      payments: payments.results || [],
    }), { status: 200, headers });
  } catch (err) {
    console.error('me error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
