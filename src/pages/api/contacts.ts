import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const password = url.searchParams.get('password');
  const adminPassword = locals.runtime.env.ADMIN_PASSWORD;

  if (!adminPassword || password !== adminPassword) {
    return new Response(JSON.stringify({ error: '인증 실패' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const db = locals.runtime.env.DB;
    const { results } = await db
      .prepare('SELECT * FROM contacts ORDER BY created_at DESC')
      .all();

    return new Response(JSON.stringify({ data: results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Contacts list error:', err);
    return new Response(JSON.stringify({ error: '서버 오류' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const password = url.searchParams.get('password');
  const adminPassword = locals.runtime.env.ADMIN_PASSWORD;

  if (!adminPassword || password !== adminPassword) {
    return new Response(JSON.stringify({ error: '인증 실패' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { id, status } = await request.json();
    const db = locals.runtime.env.DB;
    await db.prepare('UPDATE contacts SET status = ? WHERE id = ?').bind(status, id).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: '서버 오류' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
