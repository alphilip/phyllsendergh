// Admin tab logic for the main dashboard (index.html).
// Loaded AFTER app.js — it reuses app.js's $ and esc globals, and every
// name declared here is admin-prefixed so it can never collide with
// app.js's top-level names. initAdminTab() is called by app.js once the
// logged-in user is known to be an admin (or right after a claim).

async function adminApi(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function adminPill(status) {
  const cls = status === "active" ? "text-bg-success"
    : status === "suspended" ? "text-bg-danger"
    : status === "past_due" ? "text-bg-warning"
    : status === "pending_payment" ? "text-bg-info" : "text-bg-secondary";
  return `<span class="badge rounded-pill ${cls}">${esc(status)}</span>`;
}

function adminFmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return "—"; }
}

function adminFmtUptime(sec) {
  const s = Number(sec) || 0;
  if (s < 3600) return Math.floor(s / 60) + " min";
  if (s < 86400) return (s / 3600).toFixed(1) + " h";
  return (s / 86400).toFixed(1) + " days";
}

let adminAllUsers = [];

async function adminLoadAll() {
  try {
    const [stats, users, ann, health] = await Promise.all([
      adminApi("/api/admin/stats"),
      adminApi("/api/admin/users"),
      adminApi("/api/admin/announcement"),
      adminApi("/api/admin/health").catch(() => null)
    ]);
    $("adminStatGrid").innerHTML = `
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">${stats.users}</div><div class="text-secondary small">Users</div></div></div></div>
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">${stats.active}</div><div class="text-secondary small">Active</div></div></div></div>
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">${stats.past_due}</div><div class="text-secondary small">Past due</div></div></div></div>
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">${stats.suspended}</div><div class="text-secondary small">Suspended</div></div></div></div>
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">${stats.pending_payment}</div><div class="text-secondary small">Unpaid</div></div></div></div>
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">₵${stats.mrr.toFixed(2)}</div><div class="text-secondary small">Est. MRR</div></div></div></div>
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">${stats.dms24h}</div><div class="text-secondary small">DMs last 24h</div></div></div></div>
      <div class="col"><div class="card h-100"><div class="card-body py-3"><div class="fs-4 fw-bold">${stats.flagged}</div><div class="text-secondary small">Flagged ⚠</div></div></div></div>`;
    const refBox = document.getElementById("adminTopRefBox");
    if (Array.isArray(stats.topReferrers) && stats.topReferrers.length) {
      const rows = stats.topReferrers.map((r, i) =>
        `<tr><td>${i + 1}</td><td>${esc(r.email)}</td><td>${r.count}</td></tr>`).join("");
      refBox.innerHTML = `<h3 class="h5 mt-2">Top referrers</h3><div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>#</th><th>User</th><th>Referred</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else {
      refBox.innerHTML = "";
    }
    if (health) {
      $("adminHealthBox").innerHTML = `<div class="d-flex flex-wrap gap-4">
        <div><strong>Users</strong><br />${health.users}</div>
        <div><strong>WhatsApp connected</strong><br />${health.whatsappConnected} <span class="text-secondary">(${health.whatsappAwaitingQr} awaiting QR)</span></div>
        <div><strong>Paystack</strong><br />${health.billingConfigured ? "Configured ✓" : "Not set"}</div>
        <div><strong>Uptime</strong><br />${adminFmtUptime(health.uptimeSeconds)}</div>
      </div>`;
    }
    adminAllUsers = users.users;
    adminRenderUsers(adminAllUsers);
    $("adminAnnounceText").value = ann.text || "";
  } catch (err) {
    console.error("[admin tab] load failed:", err.message);
  }
}

function adminApplyUserFilter() {
  const q = ($("adminUserSearch").value || "").trim().toLowerCase();
  const f = $("adminUserFilter").value || "all";
  adminRenderUsers(adminAllUsers.filter((u) => {
    if (f === "flagged") { if (!u.flagged) return false; }
    else if (f !== "all" && u.subscription.status !== f) return false;
    if (q && !u.email.toLowerCase().includes(q)) return false;
    return true;
  }));
}

function adminRenderUsers(rows) {
  const tb = document.querySelector("#adminUsersTable tbody");
  tb.innerHTML = "";
  for (const u of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(u.email)}${u.flagged ? ' <span class="text-warning fw-bold">⚠</span>' : ""}<br />
        <span class="text-secondary">${esc(u.id.slice(0, 8))}… · since ${adminFmtDate(u.createdAt)}</span></td>
      <td>${esc(u.subscription.tierName || "—")}</td>
      <td>${adminPill(u.subscription.status)}</td>
      <td>${adminFmtDate(u.subscription.currentPeriodEnd)}<br />
        <span class="text-secondary">${u.subscription.period || "—"}</span></td>
      <td>${u.whatsapp.connected
        ? `<span class="badge rounded-pill text-bg-success">✓ ${esc(u.whatsapp.number || "linked")}</span>`
        : `<span class="text-secondary">—</span>`}</td>
      <td>${u.counts.contacts}</td>
      <td>${u.counts.dms24h}</td>
      <td></td>`;
    const actions = tr.lastElementChild;
    if (u.subscription.status === "suspended") {
      const b = document.createElement("button");
      b.textContent = "Unsuspend";
      b.className = "btn btn-sm btn-outline-success";
      b.onclick = () => adminAct(u, "unsuspend");
      actions.appendChild(b);
    } else {
      const b = document.createElement("button");
      b.textContent = "Suspend";
      b.className = "btn btn-sm btn-outline-danger";
      b.onclick = () => {
        if (confirm(`Suspend ${u.email}? Their WhatsApp will disconnect immediately.`)) adminAct(u, "suspend");
      };
      actions.appendChild(b);
    }
    const e = document.createElement("button");
    e.textContent = "Extend…";
    e.className = "btn btn-sm btn-outline-secondary ms-2";
    e.onclick = () => {
      const days = prompt(`Extend ${u.email} by how many days? (1–365)`, "30");
      if (days !== null) adminAct(u, "extend", { days: Number(days) });
    };
    actions.appendChild(e);
    const d = document.createElement("button");
    d.textContent = "Details";
    d.className = "btn btn-sm btn-outline-secondary ms-2";
    d.onclick = () => adminShowUserDetail(u.id);
    actions.appendChild(d);
    tb.appendChild(tr);
  }
}

async function adminAct(u, action, body) {
  try {
    await adminApi(`/api/admin/users/${u.id}/${action}`, { method: "POST", body: JSON.stringify(body || {}) });
    adminLoadAll();
  } catch (err) {
    alert(err.message);
  }
}

// ---- plan settings ----

function adminPlanField(tierId, key) {
  return document.getElementById(`adminPlan_${tierId}_${key}`);
}

async function adminLoadPlanSettings() {
  try {
    const data = await adminApi("/api/admin/plans");
    const box = $("adminPlanBox");
    box.innerHTML = data.tiers.map((t) => `
      <div class="border rounded p-3 mb-3">
        <h4 class="h6 mb-3">${esc(t.name)}</h4>
        <div class="d-flex flex-wrap gap-3">
          <label>Monthly (GH₵)<br /><input class="form-control" id="adminPlan_${t.id}_monthlyGhs" type="number" min="0.01" step="0.01" value="${t.prices.monthly.ghs}" style="max-width:140px" /></label>
          <label>Yearly (GH₵)<br /><input class="form-control" id="adminPlan_${t.id}_yearlyGhs" type="number" min="0.01" step="0.01" value="${t.prices.yearly.ghs}" style="max-width:140px" /></label>
          <label>Max contacts<br /><input class="form-control" id="adminPlan_${t.id}_maxContacts" type="number" min="0" max="100000" value="${t.limits.maxContacts}" style="max-width:140px" /></label>
          <label>DMs/day<br /><input class="form-control" id="adminPlan_${t.id}_dailyDmCap" type="number" min="0" max="10000" value="${t.limits.dailyDmCap}" style="max-width:120px" /></label>
          <label>DMs/hour<br /><input class="form-control" id="adminPlan_${t.id}_hourlyDmCap" type="number" min="0" max="1000" value="${t.limits.hourlyDmCap}" style="max-width:120px" /></label>
          <label>Max lists<br /><input class="form-control" id="adminPlan_${t.id}_maxLists" type="number" min="0" max="1000" value="${t.limits.maxLists}" style="max-width:120px" /></label>
        </div>
      </div>`).join("");
  } catch (err) {
    $("adminPlanBox").innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
  }
}

async function adminSavePlanSettings() {
  const msg = $("adminPlanMsg");
  msg.textContent = "";
  try {
    const tiers = {};
    for (const id of ["starter", "pro", "business"]) {
      tiers[id] = {
        monthlyGhs: Number(adminPlanField(id, "monthlyGhs").value),
        yearlyGhs: Number(adminPlanField(id, "yearlyGhs").value),
        maxContacts: Number(adminPlanField(id, "maxContacts").value),
        dailyDmCap: Number(adminPlanField(id, "dailyDmCap").value),
        hourlyDmCap: Number(adminPlanField(id, "hourlyDmCap").value),
        maxLists: Number(adminPlanField(id, "maxLists").value)
      };
    }
    const saved = await adminApi("/api/admin/plans", { method: "POST", body: JSON.stringify({ tiers }) });
    const changed = (saved.changed || []).map((c) => `${c.tierId}/${c.period}`).join(", ");
    msg.textContent = changed
      ? `Saved. New prices live for new checkouts (changed: ${changed}). Existing subscribers keep their old price.`
      : "Saved — no price changes.";
    adminLoadPlanSettings();
    adminLoadAll();
  } catch (err) {
    msg.textContent = err.message;
  }
}

// ---- per-user detail modal ----

const adminUserModalEl = document.createElement("div");
adminUserModalEl.id = "adminUserModal";
adminUserModalEl.style.cssText = "display:none;position:fixed;inset:0;background:rgba(5,10,15,.85);z-index:60;overflow:auto";
adminUserModalEl.innerHTML = `<div class="card p-4" style="max-width:720px;margin:6vh auto">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <h2 style="margin:0">User detail</h2>
    <button id="adminModalClose" class="btn btn-sm btn-outline-secondary">Close</button>
  </div>
  <div id="adminModalBody" style="margin-top:12px"></div>
</div>`;
document.body.appendChild(adminUserModalEl);
adminUserModalEl.querySelector("#adminModalClose").onclick = () => { adminUserModalEl.style.display = "none"; };
adminUserModalEl.addEventListener("click", (e) => { if (e.target === adminUserModalEl) adminUserModalEl.style.display = "none"; });

async function adminShowUserDetail(id) {
  const body = document.getElementById("adminModalBody");
  body.innerHTML = '<p class="text-secondary">Loading…</p>';
  adminUserModalEl.style.display = "block";
  try {
    const d = await adminApi(`/api/admin/users/${id}`);
    const u = d.user;
    const s = u.subscription;
    const hist = (s.history || []).slice().reverse().map((h) =>
      `<li>${esc(adminFmtDate(h.ts))} — ${esc(h.event)}</li>`).join("") || "<li class='text-secondary'>No events yet.</li>";
    const camps = (d.campaigns || []).map((c) => {
      const p = c.progress || {};
      const total = p.total || 0;
      const pct = total ? Math.round(((p.sent || 0) / total) * 100) : 0;
      return `<li><strong>${esc(c.name)}</strong> <span class="text-secondary">${esc(c.status)}${c.variants ? ` · A/B×${c.variants}` : ""}</span><br />` +
        `<span class="text-secondary">${p.sent || 0}/${total} sent (${pct}%) · ${esc(adminFmtDate(c.createdAt))}</span></li>`;
    }).join("") || "<li class='text-secondary'>No campaigns yet.</li>";
    const logs = (d.logs || []).map((l) =>
      `<li><span class="text-secondary">${esc(adminFmtDate(l.ts))}</span> [${esc(l.kind)}] ${l.ok ? "✓" : "✗"} ${esc(l.target || "")} ${esc(l.message || "")}</li>`
    ).join("") || "<li class='text-secondary'>No logs yet.</li>";
    const refs = u.referredBy ? `<p>Referred by user <code>${esc(String(u.referredBy).slice(0, 8))}…</code></p>` : "";
    body.innerHTML = `
      <h3>${esc(u.email)}</h3>
      <p class="text-secondary">${esc(u.id)} · since ${esc(adminFmtDate(u.createdAt))}${u.referralCode ? ` · referral code <code>${esc(u.referralCode)}</code>` : ""}</p>
      ${refs}
      <div class="d-flex flex-wrap gap-4">
        <div><strong>Subscription</strong><br />${adminPill(s.status)} ${esc(s.tierName || "—")} · ${esc(s.period || "—")}<br />
          <span class="text-secondary">ends ${esc(adminFmtDate(s.currentPeriodEnd))}</span></div>
        <div><strong>WhatsApp</strong><br />${u.whatsapp.connected ? `✓ ${esc(u.whatsapp.number || "linked")}` : "—"}</div>
        <div><strong>Counts</strong><br />${u.counts.contacts} contacts · ${u.counts.lists} lists · ${u.counts.campaigns} campaigns · ${u.counts.dms24h} DMs/24h</div>
      </div>
      <h4>Subscription history</h4><ul>${hist}</ul>
      <h4>Recent campaigns</h4><ul>${camps}</ul>
      <h4>Recent logs</h4><ul>${logs}</ul>
      <h4>Plan</h4>
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <select id="adminModalTier" class="form-select" style="max-width:180px">
          <option value="starter">Starter</option>
          <option value="pro">Pro</option>
          <option value="business">Business</option>
        </select>
        <select id="adminModalPeriod" class="form-select" style="max-width:180px">
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
        <button class="btn btn-sm btn-brand" data-act="save-plan">Save plan</button>
        <input id="adminModalGrantDays" class="form-control" style="max-width:120px" type="number" min="1" max="365" value="30" />
        <button class="btn btn-sm btn-outline-secondary" data-act="grant">Grant free access</button>
      </div>
      <h4>Support</h4>
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-outline-secondary" data-act="wa-disconnect">Disconnect WhatsApp</button>
        <button class="btn btn-sm btn-outline-secondary" data-act="reset-password">Reset password…</button>
      </div>
      <h4 class="text-danger">Danger</h4>
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-outline-danger" data-act="delete">Delete user…</button>
      </div>
      <div class="d-flex flex-wrap gap-2 mt-3">
        ${s.status === "suspended"
          ? `<button class="btn btn-sm btn-outline-success" data-act="unsuspend">Unsuspend</button>`
          : `<button class="btn btn-sm btn-outline-danger" data-act="suspend">Suspend</button>`}
        <button class="btn btn-sm btn-outline-secondary" data-act="extend">Extend…</button>
      </div>`;
    const mt = body.querySelector("#adminModalTier");
    if (mt) mt.value = s.tierId || "pro";
    const mp = body.querySelector("#adminModalPeriod");
    if (mp) mp.value = s.period || "monthly";
    body.querySelectorAll("[data-act]").forEach((btn) => {
      btn.onclick = async () => {
        const action = btn.dataset.act;
        let path = action;
        let payload = {};
        if (action === "suspend" && !confirm(`Suspend ${u.email}?`)) return;
        if (action === "extend") {
          const days = prompt(`Extend ${u.email} by how many days? (1–365)`, "30");
          if (days === null) return;
          payload = { days: Number(days) };
        }
        if (action === "save-plan") {
          path = "plan";
          payload = {
            tierId: body.querySelector("#adminModalTier").value,
            period: body.querySelector("#adminModalPeriod").value
          };
        }
        if (action === "grant") {
          const days = Number(body.querySelector("#adminModalGrantDays").value);
          if (!days || days < 1 || days > 365) { alert("Grant days must be between 1 and 365."); return; }
          path = "grant";
          payload = {
            days,
            period: body.querySelector("#adminModalPeriod").value,
            tierId: body.querySelector("#adminModalTier").value
          };
        }
        if (action === "wa-disconnect") {
          if (!confirm(`Disconnect WhatsApp for ${u.email}? They will need to relink from their dashboard.`)) return;
          path = "whatsapp/disconnect";
        }
        if (action === "reset-password") {
          if (!confirm(`Reset the password for ${u.email}? Their current password stops working immediately.`)) return;
          path = "reset-password";
        }
        if (action === "delete") {
          if (!confirm(`Delete ${u.email}? This removes the account, all its data and its WhatsApp session. This cannot be undone.`)) return;
          path = "delete";
        }
        try {
          const res = await adminApi(`/api/admin/users/${u.id}/${path}`, { method: "POST", body: JSON.stringify(payload) });
          if (action === "reset-password" && res.tempPassword) {
            alert(`Temporary password for ${u.email} (copy it now — it will not be shown again):\n\n${res.tempPassword}`);
          }
          adminUserModalEl.style.display = "none";
          adminLoadAll();
        } catch (err) { alert(err.message); }
      };
    });
  } catch (err) {
    body.innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
  }
}

// ---- init (called once by app.js when the user is known to be admin) ----

let adminTabInitDone = false;
function initAdminTab() {
  if (adminTabInitDone) return;
  adminTabInitDone = true;
  $("adminUserSearch").addEventListener("input", adminApplyUserFilter);
  $("adminUserFilter").addEventListener("change", adminApplyUserFilter);
  $("adminExportUsersBtn").addEventListener("click", () => {
    window.location.href = "/api/admin/users/export";
  });
  $("adminHealthRefreshBtn").addEventListener("click", async () => {
    try {
      const health = await adminApi("/api/admin/health");
      $("adminHealthBox").innerHTML = `<div class="d-flex flex-wrap gap-4">
        <div><strong>Users</strong><br />${health.users}</div>
        <div><strong>WhatsApp connected</strong><br />${health.whatsappConnected} <span class="text-secondary">(${health.whatsappAwaitingQr} awaiting QR)</span></div>
        <div><strong>Paystack</strong><br />${health.billingConfigured ? "Configured ✓" : "Not set"}</div>
        <div><strong>Uptime</strong><br />${adminFmtUptime(health.uptimeSeconds)}</div>
      </div>`;
    } catch (err) { $("adminHealthBox").innerHTML = `<p class="text-danger">${esc(err.message)}</p>`; }
  });
  $("adminSaveAnnounceBtn").addEventListener("click", async () => {
    $("adminAnnounceMsg").textContent = "";
    try {
      await adminApi("/api/admin/announcement", {
        method: "POST",
        body: JSON.stringify({ text: $("adminAnnounceText").value.trim() })
      });
      $("adminAnnounceMsg").textContent = "Saved — users will see it on next load.";
    } catch (err) {
      $("adminAnnounceMsg").textContent = err.message;
    }
  });
  $("adminClearAnnounceBtn").addEventListener("click", async () => {
    $("adminAnnounceMsg").textContent = "";
    try {
      await adminApi("/api/admin/announcement", { method: "POST", body: JSON.stringify({ text: "" }) });
      $("adminAnnounceText").value = "";
      $("adminAnnounceMsg").textContent = "Cleared.";
    } catch (err) {
      $("adminAnnounceMsg").textContent = err.message;
    }
  });
  $("adminPlanSaveBtn").addEventListener("click", adminSavePlanSettings);
  adminLoadAll();
  adminLoadPlanSettings();
}
