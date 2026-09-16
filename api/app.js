const { neon } = require('@neondatabase/serverless');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function validMonth(value) {
  return /^2026-(0[3-9]|1[0-2])-01$/.test(String(value || ''));
}

module.exports = async function handler(req, res) {
  if (!process.env.DATABASE_URL) return json(res, 500, { error: 'DATABASE_URL no está configurada' });
  const sql = neon(process.env.DATABASE_URL);
  const action = req.query?.action || '';
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  try {
    if (action === 'state' && req.method === 'GET') {
      const players = await sql`SELECT id, name FROM players WHERE active = TRUE ORDER BY name ASC`;
      const payments = await sql`
        SELECT p.id, p.month::text AS month, p.amount, p.status, p.source, p.receipt_url,
               pl.name AS player_name
        FROM payments p
        JOIN players pl ON pl.id = p.player_id
        ORDER BY p.month DESC, pl.name ASC
      `;
      const history = await sql`
        SELECT h.id, h.action, h.status_from, h.status_to, h.created_at,
               p.month::text AS month, pl.name AS player_name
        FROM payment_history h
        JOIN payments p ON p.id = h.payment_id
        JOIN players pl ON pl.id = p.player_id
        ORDER BY h.created_at DESC
        LIMIT 30
      `;
      return json(res, 200, { players, payments, history });
    }

    if (action === 'payment' && req.method === 'POST') {
      const playerName = String(body.player_name || '').trim();
      const month = String(body.month || '');
      const amount = Number(body.amount || 0);
      const source = body.source === 'admin_manual' ? 'admin_manual' : 'player_report';
      if (!playerName || !validMonth(month) || amount < 100000) return json(res, 400, { error: 'Datos de pago inválidos' });
      const playerRows = await sql`SELECT id FROM players WHERE name = ${playerName} AND active = TRUE LIMIT 1`;
      if (!playerRows.length) return json(res, 404, { error: 'Jugador no encontrado' });
      const playerId = playerRows[0].id;
      const status = source === 'admin_manual' ? 'validated' : 'pending_review';
      const rows = await sql`
        INSERT INTO payments (player_id, month, amount, status, source, updated_at, validated_at)
        VALUES (${playerId}, ${month}::date, ${amount}, ${status}, ${source}, NOW(), ${status === 'validated' ? new Date().toISOString() : null})
        ON CONFLICT (player_id, month)
        DO UPDATE SET amount = EXCLUDED.amount, status = EXCLUDED.status, source = EXCLUDED.source,
                      updated_at = NOW(), validated_at = CASE WHEN EXCLUDED.status = 'validated' THEN NOW() ELSE NULL END
        RETURNING id
      `;
      const paymentId = rows[0].id;
      const actionText = source === 'admin_manual' ? 'Pago cargado manualmente y validado' : 'Pago informado';
      await sql`INSERT INTO payment_history (payment_id, action, status_to) VALUES (${paymentId}, ${actionText}, ${status})`;
      return json(res, 200, { ok: true });
    }

    if (action === 'payment-status' && req.method === 'PATCH') {
      const playerName = String(body.player_name || '').trim();
      const month = String(body.month || '');
      const status = String(body.status || '');
      if (!playerName || !validMonth(month) || !['validated','not_received'].includes(status)) return json(res, 400, { error: 'Estado inválido' });
      const found = await sql`
        SELECT p.id, p.status FROM payments p
        JOIN players pl ON pl.id = p.player_id
        WHERE pl.name = ${playerName} AND p.month = ${month}::date
        LIMIT 1
      `;
      if (!found.length) return json(res, 404, { error: 'No hay un pago registrado para ese jugador y mes' });
      const paymentId = found[0].id;
      const previous = found[0].status;
      await sql`
        UPDATE payments SET status = ${status}, updated_at = NOW(),
          validated_at = CASE WHEN ${status} = 'validated' THEN NOW() ELSE NULL END
        WHERE id = ${paymentId}
      `;
      const actionText = status === 'validated' ? 'Pago validado' : 'Marcado como no recibido';
      await sql`INSERT INTO payment_history (payment_id, action, status_from, status_to) VALUES (${paymentId}, ${actionText}, ${previous}, ${status})`;
      return json(res, 200, { ok: true });
    }

    if (action === 'player' && req.method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'Nombre inválido' });
      await sql`INSERT INTO players (name, active) VALUES (${name}, TRUE) ON CONFLICT (name) DO UPDATE SET active = TRUE`;
      return json(res, 200, { ok: true });
    }

    if (action === 'player' && req.method === 'PATCH') {
      const oldName = String(body.old_name || '').trim();
      const newName = String(body.new_name || '').trim();
      if (!oldName || !newName) return json(res, 400, { error: 'Nombre inválido' });
      const rows = await sql`UPDATE players SET name = ${newName} WHERE name = ${oldName} RETURNING id`;
      if (!rows.length) return json(res, 404, { error: 'Jugador no encontrado' });
      return json(res, 200, { ok: true });
    }

    if (action === 'player' && req.method === 'DELETE') {
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'Nombre inválido' });
      const hasPayments = await sql`
        SELECT EXISTS(
          SELECT 1 FROM payments p JOIN players pl ON pl.id = p.player_id WHERE pl.name = ${name}
        ) AS exists
      `;
      if (hasPayments[0]?.exists) {
        await sql`UPDATE players SET active = FALSE WHERE name = ${name}`;
      } else {
        await sql`DELETE FROM players WHERE name = ${name}`;
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Acción no encontrada' });
  } catch (err) {
    console.error(err);
    const message = err?.code === '23505' ? 'Ese jugador ya existe' : 'Error al guardar los datos';
    return json(res, 500, { error: message });
  }
};
