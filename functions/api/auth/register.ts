interface Env {
  DB: D1Database;
}

function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
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
    const token = getSessionToken(request);
    if (!token) {
      return new Response(JSON.stringify({ error: '이메일 인증이 필요합니다.' }), { status: 401, headers });
    }

    const session = await env.DB
      .prepare(`SELECT email FROM sessions WHERE token = ? AND expires_at > datetime('now')`)
      .bind(token)
      .first<{ email: string }>();

    if (!session) {
      return new Response(JSON.stringify({ error: '세션이 만료되었습니다.' }), { status: 401, headers });
    }

    const { name, company, phone, password } = await request.json() as {
      name: string; company?: string; phone?: string; password: string;
    };

    // 비밀번호 재설정 시 name이 '_reset_'으로 들어옴
    const isReset = name === '_reset_';

    if (!isReset && !name) {
      return new Response(JSON.stringify({ error: '이름을 입력해주세요.' }), { status: 400, headers });
    }
    if (!password) {
      return new Response(JSON.stringify({ error: '비밀번호를 입력해주세요.' }), { status: 400, headers });
    }

    if (password.length < 6) {
      return new Response(JSON.stringify({ error: '비밀번호는 6자 이상이어야 합니다.' }), { status: 400, headers });
    }

    const passwordHash = await hashPassword(password);

    if (isReset) {
      // 비밀번호만 업데이트
      await env.DB
        .prepare(`UPDATE customers SET password_hash = ? WHERE email = ?`)
        .bind(passwordHash, session.email)
        .run();
    } else {
      await env.DB
        .prepare(`INSERT INTO customers (email, name, company, phone, password_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET name = ?, company = ?, phone = ?, password_hash = ?`)
        .bind(session.email, name, company || '', phone || '', passwordHash, name, company || '', phone || '', passwordHash)
        .run();
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err) {
    console.error('register error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
