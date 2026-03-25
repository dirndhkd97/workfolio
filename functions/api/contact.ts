interface Env {
  DB: D1Database;
}

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
