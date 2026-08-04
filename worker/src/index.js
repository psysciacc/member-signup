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

// sisUserId is our own D1 `signups.id` — the SIS-visible identifier Canvas uses
// for this person, so enrollments can reference them without ever matching on
// name/email fuzziness.
async function createCanvasUser(env, { first, last, email, sisUserId }) {
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
        pseudonym: {
          unique_id: email,
          sis_user_id: String(sisUserId),
          send_confirmation: true,
        },
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

// Finds a prior signup row for this email that already has a Canvas account,
// so a repeat/duplicate signup reuses the same Canvas user instead of trying
// (and failing) to create a second account with the same login email.
async function findPriorCanvasSisId(env, { id, email }) {
  const prior = await env.DB.prepare(
    "SELECT id FROM signups WHERE email = ? AND id != ? AND canvas_user_id IS NOT NULL ORDER BY id DESC LIMIT 1",
  )
    .bind(email, id)
    .first();
  return prior ? String(prior.id) : null;
}

// Returns the Canvas SIS user id ("sis_user_id:<value>" form usable anywhere
// Canvas accepts a user id) to enroll, creating the Canvas account if needed.
async function findOrCreateCanvasSisId(env, { id, first, last, email }) {
  const priorSisId = await findPriorCanvasSisId(env, { id, email });
  if (priorSisId) {
    return `sis_user_id:${priorSisId}`;
  }
  const canvasUserId = await createCanvasUser(env, { first, last, email, sisUserId: id });
  await env.DB.prepare("UPDATE signups SET canvas_user_id = ? WHERE id = ?")
    .bind(String(canvasUserId), id)
    .run();
  return `sis_user_id:${id}`;
}

async function hasActiveCanvasEnrollment(env, { sisId, courseId }) {
  const res = await fetch(
    `${env.CANVAS_BASE_URL}/api/v1/courses/${courseId}/enrollments?user_id=${sisId}`,
    { headers: { Authorization: `Bearer ${env.CANVAS_API_TOKEN}` } },
  );
  if (!res.ok) {
    throw new Error(`Canvas error ${res.status}: ${await res.text()}`);
  }
  const enrollments = await res.json();
  return enrollments.some((e) => ["active", "pending", "invited"].includes(e.enrollment_state));
}

async function enrollInCanvasCourse(env, { sisId, courseId }) {
  if (await hasActiveCanvasEnrollment(env, { sisId, courseId })) {
    return; // already enrolled, avoid creating a duplicate enrollment
  }
  const res = await fetch(`${env.CANVAS_BASE_URL}/api/v1/courses/${courseId}/enrollments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CANVAS_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      enrollment: {
        user_id: sisId,
        role: env.CANVAS_ENROLLMENT_ROLE,
        enrollment_state: "active",
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Canvas enrollment error ${res.status}: ${await res.text()}`);
  }
}

async function rejectSilently(env, { ip, reason, first, last, email, notes }) {
  // Looks identical to a real success response so scripted spam doesn't learn
  // what tripped the filter and adapt. The real submission still gets logged
  // to blocked_signups so it can be reviewed later.
  await env.DB.prepare(
    "INSERT INTO blocked_signups (created_at, ip, reason, first_name, last_name, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(new Date().toISOString(), ip, reason, first, last, email, notes)
    .run();
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
  const blockedInfo = { ip, first, last, email, notes };

  await env.DB.prepare("INSERT INTO submission_attempts (ip, created_at) VALUES (?, ?)")
    .bind(ip, now.toISOString())
    .run();

  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM submission_attempts WHERE ip = ? AND created_at > ?",
  )
    .bind(ip, oneHourAgo)
    .first();

  if (count > Number(env.RATE_LIMIT_PER_HOUR)) {
    return rejectSilently(env, { ...blockedInfo, reason: "rate_limit" });
  }

  // Honeypot field: real users never fill this in, bots often do.
  if (body.website) {
    return rejectSilently(env, { ...blockedInfo, reason: "honeypot" });
  }

  // Time-trap: a real person needs at least a few seconds to fill out the form.
  const elapsed = Date.now() - Number(body.renderedAt || 0);
  if (!Number.isFinite(elapsed) || elapsed < Number(env.MIN_SUBMIT_MS)) {
    return rejectSilently(env, { ...blockedInfo, reason: "time_trap" });
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
    const sisId = await findOrCreateCanvasSisId(env, {
      id: row.id,
      first: row.first_name,
      last: row.last_name,
      email: row.email,
    });

    const courseIds = [];
    if (row.join_accelerator === "Yes") courseIds.push(env.CANVAS_PSA_COURSE_ID);
    if (row.join_many_languages === "Yes") courseIds.push(env.CANVAS_ML_COURSE_ID);

    for (const courseId of courseIds) {
      await enrollInCanvasCourse(env, { sisId, courseId });
    }

    await env.DB.prepare("UPDATE signups SET status = 'approved', decided_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
    return html(
      `<h3>Approved</h3><p>${row.first_name} ${row.last_name} was added to Canvas (${sisId}) and enrolled as Researcher in ${courseIds.length} course(s).</p>`,
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

async function handleExportBlocked(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.HMAC_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM blocked_signups ORDER BY id DESC",
  ).all();
  const header = "id,created_at,ip,reason,first_name,last_name,email,notes";
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = results.map((r) =>
    [r.id, r.created_at, r.ip, r.reason, r.first_name, r.last_name, r.email, r.notes]
      .map(escape)
      .join(","),
  );
  const csv = [header, ...rows].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=blocked_signups.csv",
    },
  });
}

// Manual admin path for enrolling rows that are already `approved` (e.g.
// imported legacy members) and so never go through the pending /decision
// flow. Same underlying logic as an approve click, just addressable by id
// with explicit course flags instead of reading join_accelerator/ml off the row.
async function handleAdminEnroll(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.HMAC_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await request.json();
  const id = Number(body.sis_id);
  const wantPsa = !!body.psa;
  const wantMl = !!body.ml;

  const row = await env.DB.prepare("SELECT * FROM signups WHERE id = ?").bind(id).first();
  if (!row) {
    return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
  }

  const first = row.first_name || row.email.split("@")[0];
  const last = row.last_name || "(legacy)";

  try {
    const sisId = await findOrCreateCanvasSisId(env, { id: row.id, first, last, email: row.email });

    const courseIds = [];
    if (wantPsa) courseIds.push(env.CANVAS_PSA_COURSE_ID);
    if (wantMl) courseIds.push(env.CANVAS_ML_COURSE_ID);
    for (const courseId of courseIds) {
      await enrollInCanvasCourse(env, { sisId, courseId });
    }

    await env.DB.prepare(
      "UPDATE signups SET join_accelerator = ?, join_many_languages = ? WHERE id = ?",
    )
      .bind(wantPsa ? "Yes" : "No", wantMl ? "Yes" : "No", id)
      .run();

    return new Response(JSON.stringify({ ok: true, sisId, courses: courseIds.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/admin/enroll" && request.method === "POST") {
      return handleAdminEnroll(request, env);
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

    if (url.pathname === "/export/blocked" && request.method === "GET") {
      return handleExportBlocked(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
