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

    const { subscriptionId } = await request.json() as { subscriptionId: number };

    // 본인 구독인지 확인
    const sub = await env.DB
      .prepare(`SELECT id, status FROM subscriptions WHERE id = ? AND customer_email = ?`)
      .bind(subscriptionId, session.email)
      .first<{ id: number; status: string }>();

    if (!sub) {
      return new Response(JSON.stringify({ error: '구독 정보를 찾을 수 없습니다.' }), { status: 404, headers });
    }

    if (sub.status !== 'active') {
      return new Response(JSON.stringify({ error: '이미 해지된 구독입니다.' }), { status: 400, headers });
    }

    await env.DB
      .prepare(`UPDATE subscriptions SET status = 'cancel_requested', updated_at = datetime('now') WHERE id = ?`)
      .bind(subscriptionId)
      .run();

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err) {
    console.error('billing cancel error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
