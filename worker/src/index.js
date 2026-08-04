// PSA / ManyLanguages member signup worker.
//
// Routes:
//   POST /submit    - receives the public signup form, stores it in D1, emails an admin
//                      an approve/deny link via SendGrid
//   GET  /decision   - approve/deny link target; verifies the signed token, updates the
//                      row, and (on approve) creates the person as a Canvas user
//
// Required secrets (wrangler secret put <NAME>):
//   SENDGRID_API_KEY   - SendGrid API key with mail-send scope
//   HMAC_SECRET         - random string used to sign approve/deny links
//   CANVAS_API_TOKEN    - Canvas admin API token, scoped to create users on CANVAS_ACCOUNT_ID
//
// Required vars (see wrangler.toml):
//   ADMIN_EMAIL, FROM_EMAIL, CANVAS_BASE_URL, CANVAS_ACCOUNT_ID, ALLOWED_ORIGIN

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function html(body, status = 200) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Signup</title>
      <style>body{font-family:Arial,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;text-align:center}</style>
      </head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function sendEmail(env, { to, subject, text, html: htmlBody }) {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.FROM_EMAIL },
      reply_to: { email: env.ADMIN_EMAIL },
      subject,
      content: [
        { type: "text/plain", value: text },
        ...(htmlBody ? [{ type: "text/html", value: htmlBody }] : []),
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`SendGrid error ${res.status}: ${await res.text()}`);
  }
}

async function createCanvasUser(env, { first, last, email }) {
  const res = await fetch(
    `${env.CANVAS_BASE_URL}/api/v1/accounts/${env.CANVAS_ACCOUNT_ID}/users`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CANVAS_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user: { name: `${first} ${last}`, terms_of_use: true },
        pseudonym: { unique_id: email, send_confirmation: true },
        communication_channel: { type: "email", address: email, skip_confirmation: false },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Canvas error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.id;
}

function rejectSilently(env) {
  // Looks identical to a real success response so scripted spam doesn't learn
  // what tripped the filter and adapt.
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function handleSubmit(request, env) {
  const body = await request.json();
  const first = (body.first || "").trim();
  const last = (body.last || "").trim();
  const email = (body.email || "").trim();
  const notes = (body.notes || "").trim();
  const joinAccelerator = body.joinAccelerator === "Yes" ? "Yes" : "No";
  const joinManyLanguages = body.joinManyLanguages === "Yes" ? "Yes" : "No";

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  await env.DB.prepare("INSERT INTO submission_attempts (ip, created_at) VALUES (?, ?)")
    .bind(ip, now.toISOString())
    .run();

  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM submission_attempts WHERE ip = ? AND created_at > ?",
  )
    .bind(ip, oneHourAgo)
    .first();

  if (count > Number(env.RATE_LIMIT_PER_HOUR)) {
    return rejectSilently(env);
  }

  // Honeypot field: real users never fill this in, bots often do.
  if (body.website) {
    return rejectSilently(env);
  }

  // Time-trap: a real person needs at least a few seconds to fill out the form.
  const elapsed = Date.now() - Number(body.renderedAt || 0);
  if (!Number.isFinite(elapsed) || elapsed < Number(env.MIN_SUBMIT_MS)) {
    return rejectSilently(env);
  }

  if (!first || !last || !email) {
    return new Response(JSON.stringify({ ok: false, error: "Missing required fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(env) },
    });
  }

  const createdAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO signups (created_at, first_name, last_name, email, notes, join_accelerator, join_many_languages, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  )
    .bind(createdAt, first, last, email, notes, joinAccelerator, joinManyLanguages)
    .run();

  const id = result.meta.last_row_id;

  const workerOrigin = new URL(request.url).origin;
  const approveSig = await hmacHex(env.HMAC_SECRET, `${id}:approve`);
  const denySig = await hmacHex(env.HMAC_SECRET, `${id}:deny`);
  const approveUrl = `${workerOrigin}/decision?id=${id}&action=approve&sig=${approveSig}`;
  const denyUrl = `${workerOrigin}/decision?id=${id}&action=deny&sig=${denySig}`;

  await sendEmail(env, {
    to: env.ADMIN_EMAIL,
    subject: `New signup: ${first} ${last}`,
    text: `${first} ${last} <${email}> signed up.

PSA: ${joinAccelerator}
ManyLanguages: ${joinManyLanguages}
Notes: ${notes || "(none)"}

Approve: ${approveUrl}
Deny: ${denyUrl}`,
    html: `<p><strong>${first} ${last}</strong> &lt;${email}&gt; signed up.</p>
      <p>PSA: ${joinAccelerator}<br>ManyLanguages: ${joinManyLanguages}<br>Notes: ${notes || "(none)"}</p>
      <p>
        <a href="${approveUrl}" style="padding:10px 18px;background:#2e7d32;color:#fff;text-decoration:none;border-radius:4px;margin-right:10px">Approve</a>
        <a href="${denyUrl}" style="padding:10px 18px;background:#c62828;color:#fff;text-decoration:none;border-radius:4px">Deny</a>
      </p>`,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

async function handleDecision(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const action = url.searchParams.get("action");
  const sig = url.searchParams.get("sig");

  if (!id || !["approve", "deny"].includes(action) || !sig) {
    return html("<h3>Invalid link</h3>", 400);
  }

  const expected = await hmacHex(env.HMAC_SECRET, `${id}:${action}`);
  if (expected !== sig) {
    return html("<h3>Invalid or tampered link</h3>", 403);
  }

  const row = await env.DB.prepare("SELECT * FROM signups WHERE id = ?").bind(id).first();
  if (!row) {
    return html("<h3>Signup not found</h3>", 404);
  }
  if (row.status !== "pending") {
    return html(`<h3>Already ${row.status}</h3><p>No action taken.</p>`);
  }

  if (action === "deny") {
    await env.DB.prepare("UPDATE signups SET status = 'denied', decided_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
    return html(`<h3>Denied</h3><p>${row.first_name} ${row.last_name} was marked as denied.</p>`);
  }

  // action === "approve"
  try {
    const canvasUserId = await createCanvasUser(env, {
      first: row.first_name,
      last: row.last_name,
      email: row.email,
    });
    await env.DB.prepare(
      "UPDATE signups SET status = 'approved', decided_at = ?, canvas_user_id = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), String(canvasUserId), id)
      .run();
    return html(
      `<h3>Approved</h3><p>${row.first_name} ${row.last_name} was created in Canvas (user #${canvasUserId}) and will receive a confirmation email from Canvas.</p>`,
    );
  } catch (err) {
    return html(
      `<h3>Approved, but Canvas enrollment failed</h3><p>${row.first_name} ${row.last_name}'s status was NOT changed. Error: ${err.message}</p>`,
      500,
    );
  }
}

async function handleExport(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.HMAC_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { results } = await env.DB.prepare("SELECT * FROM signups ORDER BY id").all();
  const header = "id,created_at,first_name,last_name,email,notes,join_accelerator,join_many_languages,status,decided_at,canvas_user_id";
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = results.map((r) =>
    [
      r.id,
      r.created_at,
      r.first_name,
      r.last_name,
      r.email,
      r.notes,
      r.join_accelerator,
      r.join_many_languages,
      r.status,
      r.decided_at,
      r.canvas_user_id,
    ]
      .map(escape)
      .join(","),
  );
  const csv = [header, ...rows].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=signups.csv",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/submit" && request.method === "POST") {
      try {
        return await handleSubmit(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders(env) },
        });
      }
    }

    if (url.pathname === "/decision" && request.method === "GET") {
      return handleDecision(request, env);
    }

    if (url.pathname === "/export" && request.method === "GET") {
      return handleExport(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
