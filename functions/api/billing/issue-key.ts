interface Env {
  DB: D1Database;
  TOSS_SECRET_KEY: string;
  MAILGUN_API_KEY: string;
}

function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

const PLANS: Record<string, { name: string; amount: number }> = {
  'web-lite':        { name: 'Lite', amount: 30000 },
  'web-standard':    { name: 'Standard', amount: 70000 },
  'web-pro':         { name: 'Pro', amount: 150000 },
  'app-basic':       { name: 'App Basic', amount: 100000 },
  'app-standard':    { name: 'App Standard', amount: 200000 },
  'app-pro':         { name: 'App Pro', amount: 350000 },
  'bundle-standard': { name: 'Bundle Standard', amount: 220000 },
  'bundle-pro':      { name: 'Bundle Pro', amount: 400000 },
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const { authKey, customerKey, plan } =
      await request.json() as Record<string, string>;

    if (!authKey || !customerKey || !plan) {
      return new Response(JSON.stringify({ error: '필수 파라미터가 누락되었습니다.' }), { status: 400, headers });
    }

    // 세션에서 회원 정보 가져오기
    const token = getSessionToken(request);
    let customerEmail = '';
    let customerName = '';
    let customerPhone = '';

    if (token) {
      const session = await env.DB
        .prepare(`SELECT email FROM sessions WHERE token = ? AND expires_at > datetime('now')`)
        .bind(token)
        .first<{ email: string }>();

      if (session) {
        customerEmail = session.email;
        const customer = await env.DB
          .prepare(`SELECT name, phone FROM customers WHERE email = ?`)
          .bind(session.email)
          .first<{ name: string; phone: string }>();
        if (customer) {
          customerName = customer.name;
          customerPhone = customer.phone;
        }
      }
    }

    const planInfo = PLANS[plan];
    if (!planInfo) {
      return new Response(JSON.stringify({ error: '유효하지 않은 플랜입니다.' }), { status: 400, headers });
    }

    // 토스페이먼츠 빌링키 발급
    const secretKey = env.TOSS_SECRET_KEY;
    const authHeader = 'Basic ' + btoa(secretKey + ':');

    const tossRes = await fetch('https://api.tosspayments.com/v1/billing/authorizations/issue', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ authKey, customerKey }),
    });

    const tossData = await tossRes.json() as Record<string, unknown>;

    if (!tossRes.ok) {
      return new Response(JSON.stringify({
        error: (tossData as { message?: string }).message || '빌링키 발급에 실패했습니다.',
      }), { status: 400, headers });
    }

    const billingKey = tossData.billingKey as string;

    // DB에 구독 정보 저장
    await env.DB
      .prepare(
        `INSERT INTO subscriptions (customer_key, billing_key, customer_name, customer_email, customer_phone, plan, amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .bind(customerKey, billingKey, customerName || '', customerEmail || '', customerPhone || '', plan, planInfo.amount)
      .run();

    // 첫 결제 실행
    const orderId = 'order_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const payRes = await fetch(`https://api.tosspayments.com/v1/billing/${billingKey}`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customerKey,
        amount: planInfo.amount,
        orderId,
        orderName: `Workfolio ${planInfo.name} 구독`,
        customerEmail,
        customerName,
      }),
    });

    const payData = await payRes.json() as Record<string, unknown>;

    if (!payRes.ok) {
      return new Response(JSON.stringify({
        error: (payData as { message?: string }).message || '결제에 실패했습니다.',
      }), { status: 400, headers });
    }

    // 결제 내역 저장
    await env.DB
      .prepare(
        `INSERT INTO payments (customer_key, payment_key, order_id, amount, status, paid_at)
         VALUES (?, ?, ?, ?, 'done', datetime('now'))`
      )
      .bind(customerKey, payData.paymentKey as string, orderId, planInfo.amount)
      .run();

    return new Response(JSON.stringify({
      success: true,
      planName: planInfo.name,
      amount: planInfo.amount,
    }), { status: 200, headers });

  } catch (err) {
    console.error('Billing issue-key error:', err);
    return new Response(JSON.stringify({ error: '서버 오류가 발생했습니다.' }), { status: 500, headers });
  }
};
