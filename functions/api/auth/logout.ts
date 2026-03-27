interface Env {
  DB: D1Database;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);

  if (match) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(match[1]).run();
  }

  const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
  responseHeaders.set('Set-Cookie', 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: responseHeaders });
};
