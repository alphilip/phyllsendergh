const $ = (id) => document.getElementById(id);
const state = {
  groups: [],
  selectedGroups: new Set(),
  groupNames: {},
  selectedContacts: new Set(),
  allChats: [],
  selectedChats: new Set(),
  lists: [],
  serverGroupNames: {}
};

function sourceLabel(s) {
  if (s === "import:manual") return "Typed numbers";
  if (s === "import:csv") return "CSV upload";
  if (s === "inbound") return "Messaged you";
  if (s.startsWith("dm:")) return "Direct chat";
  if (s.startsWith("welcomed:")) return "Welcomed";
  return state.groupNames[s] || state.serverGroupNames[s] || s;
}

function updateSelectedCount() {
  const n = state.selectedContacts.size;
  $("selectedCount").textContent = n;
  $("selectedAudCount").textContent = n;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("Not signed in.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 402 && data.billingRequired) {
    showPaywall(data.subscriptionStatus, data.error);
    throw new Error(data.error || "Payment required.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- billing ---------- */

let paywallPeriod = "monthly";

function showPaywall(status, message) {
  const title = $("paywallTitle");
  const text = $("paywallText");
  if (status === "suspended") {
    title.textContent = "Account suspended";
    text.textContent = message || "Your subscription has expired. Renew to reactivate your account.";
  } else {
    title.textContent = "Activate your Pro plan";
    text.textContent = message || "Complete your payment to unlock the dashboard.";
  }
  $("paywall").style.display = "block";
}

document.querySelectorAll("#paywallToggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#paywallToggle button").forEach((b) => {
      b.classList.remove("active");
      b.style.borderColor = "#2a3a4a";
      b.style.background = "#15202b";
    });
    btn.classList.add("active");
    btn.style.borderColor = "#00a37a";
    btn.style.background = "#0d2b22";
    paywallPeriod = btn.dataset.period;
    updatePaywallBtn();
  });
});
function updatePaywallBtn() {
  $("paywallPayBtn").textContent = paywallPeriod === "yearly" ? "Pay GH₵39.99 for a year" : "Pay GH₵4.99 for a month";
}
updatePaywallBtn();

async function startCheckout(period) {
  const msg = $("paywallMsg");
  msg.textContent = "";
  const res = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ period })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not start checkout.");
  if (typeof PaystackPop === "undefined") throw new Error("Payment library failed to load. Check your connection and try again.");
  return new Promise((resolve, reject) => {
    const popup = new PaystackPop();
    popup.newTransaction({
      key: data.key,
      email: data.email,
      amount: data.amount,
      currency: data.currency,
      reference: data.reference,
      channels: data.channels,
      metadata: data.metadata,
      onSuccess: () => resolve(data.reference),
      onCancel: () => reject(new Error("Payment window closed — no charge was made.")),
      onError: (err) => reject(new Error((err && err.message) || "Payment failed."))
    });
  });
}

async function pollForActivation(msgEl) {
  msgEl.style.color = "#9fb3c8";
  msgEl.textContent = "Confirming your payment…";
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const s = await fetch("/api/billing/status").then((r) => r.json());
      if (s && s.status === "active") { location.reload(); return; }
    } catch {}
  }
  msgEl.style.color = "";
  msgEl.textContent = "Still confirming — stay on this page; you'll be let in automatically.";
}

$("paywallPayBtn").addEventListener("click", async () => {
  const msg = $("paywallMsg");
  try {
    await startCheckout(paywallPeriod);
    await pollForActivation(msg);
  } catch (err) {
    msg.textContent = err.message;
  }
});

$("paywallLogout").addEventListener("click", async (e) => {
  e.preventDefault();
  try { await fetch("/api/auth/logout", { method: "POST" }); } finally { location.href = "/login.html"; }
});

async function loadBilling() {
  try {
    const s = await api("/api/billing/status");
    const pill = $("subPill");
    pill.style.display = "";
    const end = s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : "";
    if (s.status === "active") {
      pill.textContent = `Pro · until ${end}`;
      pill.className = "pill ok";
    } else if (s.status === "past_due") {
      pill.textContent = "Pro · past due";
      pill.className = "pill warn";
    } else {
      pill.textContent = `Pro · ${s.status.replace("_", " ")}`;
      pill.className = "pill warn";
    }
    const showRenew = s.billingConfigured !== false && (s.status === "past_due" || s.renewSoon);
    $("renewBtn").style.display = showRenew ? "" : "none";
    if (s.status === "past_due") {
      $("pastDueText").textContent = `Your Pro plan expired${end ? " on " + end : ""}. Sending is paused until you renew — your data and WhatsApp session are safe.`;
      $("pastDueBanner").style.display = "";
    } else {
      $("pastDueBanner").style.display = "none";
    }
  } catch (e) {
    // api() already handled 401/402
  }
}

async function renewNow() {
  const msg = $("paywallMsg");
  msg.textContent = "";
  $("paywall").style.display = "block";
  $("paywallTitle").textContent = "Renew your Pro plan";
  $("paywallText").textContent = "One quick payment extends your subscription.";
}
$("renewBtn").addEventListener("click", renewNow);
$("pastDueRenewBtn").addEventListener("click", renewNow);
loadBilling();
loadAnnouncement();

/* ---------- owner announcement banner (dismissible) ---------- */
async function loadAnnouncement() {
  try {
    const data = await api("/api/announcement");
    const text = (data.text || "").trim();
    if (!text || !data.updatedAt) return;
    // Dismissal is per-announcement (keyed by its timestamp).
    if (localStorage.getItem("announceDismissedAt") === data.updatedAt) return;
    $("announceBannerText").textContent = text;
    $("announceBanner").style.display = "";
    $("announceDismissBtn").onclick = () => {
      localStorage.setItem("announceDismissedAt", data.updatedAt);
      $("announceBanner").style.display = "none";
    };
  } catch {
    // Not logged in or endpoint unavailable — stay silent.
  }
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
});

/* ---------- session ---------- */
async function loadMe() {
  try {
    const { user } = await api("/api/auth/me");
    $("userEmail").textContent = user.email;
  } catch (e) {
    // api() already redirected to /login.html on 401
  }
}
$("logoutBtn").addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    location.href = "/login.html";
  }
});
loadMe();

/* ---------- connection ---------- */
async function loadStatus() {
  $("statusError").textContent = "";
  try {
    const s = await api("/api/status");
    $("statusText").textContent = s.status;
    $("numberText").textContent = s.number || "-";
    const pill = $("connPill");
    pill.textContent = s.status;
    pill.className = "pill" + (s.status === "connected" ? " ok" : s.status === "qr" ? " warn" : "");
    if (s.qr) {
      $("qrImg").src = s.qr;
      $("qrImg").style.display = "block";
      $("qrHint").style.display = "none";
    } else {
      $("qrImg").style.display = "none";
      $("qrHint").style.display = "block";
      $("qrHint").textContent = s.status === "connected"
        ? "Linked. You can now load groups."
        : "QR code will appear here after the service starts. Save the admin token first.";
    }
  } catch (e) {
    $("statusError").textContent = e.message;
  }
}
$("refreshStatusBtn").addEventListener("click", loadStatus);
$("disconnectBtn").addEventListener("click", async () => {
  if (!confirm("Disconnect WhatsApp and generate a fresh QR code?")) return;
  try {
    await api("/api/disconnect", { method: "POST" });
    loadStatus();
  } catch (e) {
    $("statusError").textContent = e.message;
  }
});

/* ---------- groups ---------- */
function groupTypeLabel(g) {
  if (g.isCommunity) return ["Community", "community"];
  if (g.isAnnounce) return ["Announce", "announce"];
  return ["Group", ""];
}

async function loadGroups() {
  $("groupsError").textContent = "";
  try {
    const { groups } = await api("/api/chats");
    state.groups = groups;
    state.groupNames = Object.fromEntries(groups.map((g) => [g.id, g.name]));
    state.selectedGroups = new Set([...state.selectedGroups].filter((id) => state.groupNames[id]));
    renderGroups();
    renderGroupPickers();
    $("groupsCount").textContent = `${groups.length} chats found`;
  } catch (e) {
    $("groupsError").textContent = e.message;
  }
}

function renderGroups() {
  const tbody = $("groupsTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const g of state.groups) {
    const [label, cls] = groupTypeLabel(g);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-jid="${esc(g.id)}" ${state.selectedGroups.has(g.id) ? "checked" : ""} /></td>
      <td>${esc(g.name)}</td>
      <td><span class="badge ${cls}">${label}</span></td>
      <td>${g.participantCount}</td>`;
    tr.querySelector("input").addEventListener("change", (ev) => {
      if (ev.target.checked) state.selectedGroups.add(g.id);
      else state.selectedGroups.delete(g.id);
    });
    tbody.appendChild(tr);
  }
}

function renderGroupPickers() {
  const mk = (container, prefix) => {
    container.innerHTML = "";
    if (!state.groups.length) {
      container.innerHTML = '<span class="muted">Load groups first (Groups tab).</span>';
      return;
    }
    for (const g of state.groups) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = g.id;
      cb.id = `${prefix}-${g.id}`;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(` ${g.name} (${g.participantCount})`));
      container.appendChild(label);
    }
  };
  mk($("campGroupPicker"), "campg");
  mk($("schedGroupPicker"), "schedg");
  mk($("pollGroupPicker"), "pollg");
  // Welcome rule group dropdown.
  const welSel = $("welGroup");
  const welKeep = welSel.value;
  welSel.innerHTML = '<option value="">Choose a group…</option>';
  for (const g of state.groups) {
    const opt = document.createElement("option");
    opt.value = g.jid;
    opt.textContent = `${g.name} (${g.participantCount})`;
    welSel.appendChild(opt);
  }
  if (welKeep) welSel.value = welKeep;
  populateSourceFilter();
}

function pickedGroups(container) {
  return [...container.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.readAsDataURL(file);
  });
}

async function getImageData(inputId) {
  const file = $(inputId).files[0];
  if (!file) return "";
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be under 5MB.");
  return readFileAsDataUrl(file);
}

$("loadGroupsBtn").addEventListener("click", loadGroups);

$("viewParticipantsBtn").addEventListener("click", async () => {
  $("participantsHint").textContent = "";
  const jid = [...state.selectedGroups][0];
  if (!jid) {
    $("participantsHint").textContent = "Tick at least one group first.";
    return;
  }
  try {
    const { participants } = await api(`/api/chats/${encodeURIComponent(jid)}/participants`);
    const tbody = $("participantsTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const p of participants) {
      const tr = document.createElement("tr");
      const numCell = p.digits ? `+${esc(p.digits)}` : `<span class="badge">hidden</span>`;
      tr.innerHTML = `<td>${numCell}</td><td>${esc(p.name || "-")}</td><td>${esc(p.admin || (p.isSelf ? "you" : "member"))}</td>`;
      tbody.appendChild(tr);
    }
    $("participantsTable").style.display = "table";
    $("participantsHint").textContent = `${participants.length} participants in ${state.groupNames[jid] || jid}`;
  } catch (e) {
    $("participantsHint").textContent = e.message;
  }
});

$("extractBtn").addEventListener("click", async () => {
  $("extractResult").textContent = "";
  const groupJids = [...state.selectedGroups];
  if (!groupJids.length) {
    $("extractResult").textContent = "Tick at least one group first.";
    return;
  }
  $("extractResult").textContent = "Extracting…";
  try {
    const groupNames = {};
    for (const jid of groupJids) {
      if (state.groupNames[jid]) groupNames[jid] = state.groupNames[jid];
    }
    const r = await api("/api/extract", {
      method: "POST",
      body: JSON.stringify({ groupJids, groupNames, excludeSelf: true })
    });
    $("extractResult").textContent = `Done: ${r.participants} participants scanned, ${r.added} new contacts (${r.withNumbers} with real numbers, ${r.hidden} hidden by WhatsApp).`;
    // Jump to the Contacts tab filtered to the first extracted group.
    $("contactSourceFilter").value = groupJids[0];
    loadContacts();
    document.querySelector('.tabs button[data-tab="contacts"]').click();
  } catch (e) {
    $("extractResult").textContent = e.message;
  }
});

/* ---------- all chats ---------- */
function fmtLastActive(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

async function loadAllChats() {
  $("allChatsError").textContent = "";
  try {
    const { chats } = await api("/api/chats/all");
    state.allChats = chats;
    const known = new Set(chats.map((c) => c.jid));
    state.selectedChats = new Set([...state.selectedChats].filter((id) => known.has(id)));
    renderAllChats();
    $("allChatsCount").textContent = `${chats.length} chats`;
  } catch (e) {
    $("allChatsError").textContent = e.message;
  }
}

function renderAllChats() {
  const tbody = $("allChatsTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const c of state.allChats) {
    const tr = document.createElement("tr");
    const numCell = c.isGroup
      ? '<span class="muted">—</span>'
      : c.digits
        ? `+${esc(c.digits)}`
        : `<span class="badge">hidden</span>`;
    tr.innerHTML = `
      <td><input type="checkbox" ${state.selectedChats.has(c.jid) ? "checked" : ""} /></td>
      <td>${esc(c.name || c.jid)}</td>
      <td><span class="badge">${c.isGroup ? "Group" : "DM"}</span>${c.unreadCount ? ` <span class="muted">(${c.unreadCount} unread)</span>` : ""}</td>
      <td>${numCell}</td>
      <td class="muted">${esc(fmtLastActive(c.lastActive))}</td>`;
    tr.querySelector("input").addEventListener("change", (ev) => {
      if (ev.target.checked) state.selectedChats.add(c.jid);
      else state.selectedChats.delete(c.jid);
    });
    tbody.appendChild(tr);
  }
}

$("loadAllChatsBtn").addEventListener("click", loadAllChats);

$("extractChatsBtn").addEventListener("click", async () => {
  $("extractChatsResult").textContent = "";
  const selected = state.allChats.filter((c) => state.selectedChats.has(c.jid));
  if (!selected.length) {
    $("extractChatsResult").textContent = "Tick at least one chat first.";
    return;
  }
  const groupJids = selected.filter((c) => c.isGroup).map((c) => c.jid);
  const dmJids = selected.filter((c) => !c.isGroup).map((c) => c.jid);
  $("extractChatsResult").textContent = "Extracting…";
  try {
    const groupNames = {};
    for (const c of selected) {
      if (c.isGroup && c.name) groupNames[c.jid] = c.name;
    }
    const r = await api("/api/extract", {
      method: "POST",
      body: JSON.stringify({ groupJids, dmJids, groupNames, excludeSelf: true })
    });
    $("extractChatsResult").textContent = `Done: ${r.participants} people scanned, ${r.added} new contacts (${r.withNumbers} with real numbers, ${r.hidden} hidden by WhatsApp).`;
    if (groupJids.length) {
      $("contactSourceFilter").value = groupJids[0];
      loadContacts();
      document.querySelector('.tabs button[data-tab="contacts"]').click();
    } else {
      loadContacts();
    }
  } catch (e) {
    $("extractChatsResult").textContent = e.message;
  }
});

/* ---------- contacts source filter ---------- */
function populateSourceFilter() {
  const sel = $("contactSourceFilter");
  const keep = sel.value;
  // Known sources: loaded groups + persisted names + special sources.
  const seen = new Map(); // value -> label
  for (const g of state.groups) seen.set(g.jid, g.name);
  for (const [jid, name] of Object.entries(state.serverGroupNames)) {
    if (!seen.has(jid)) seen.set(jid, name);
  }
  sel.innerHTML = '<option value="">All sources</option>';
  const groupOpts = [...seen.entries()]
    .filter(([jid]) => jid.endsWith("@g.us"))
    .sort((a, b) => a[1].localeCompare(b[1]));
  for (const [jid, name] of groupOpts) {
    const opt = document.createElement("option");
    opt.value = jid;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  for (const [val, label] of [["import:manual", "Typed numbers"], ["import:csv", "CSV upload"], ["inbound", "Messaged you"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  if (keep) sel.value = keep;
}

/* ---------- contacts ---------- */
async function loadContacts() {
  const params = new URLSearchParams({
    search: $("contactSearch").value.trim(),
    source: $("contactSourceFilter").value,
    list: $("contactListFilter").value,
    optedOut: $("contactOptFilter").value
  });
  try {
    const { contacts, total, groupNames } = await api(`/api/contacts?${params}`);
    state.serverGroupNames = groupNames || {};
    populateSourceFilter();
    $("contactsCount").textContent = `${contacts.length} shown / ${total} total`;
    const tbody = $("contactsTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const c of contacts) {
      const tr = document.createElement("tr");
      const sources = c.sourceGroups.map((g) => esc(sourceLabel(g))).join(", ");
      const numCell = c.digits ? `+${esc(c.digits)}` : `<span class="badge">hidden</span>`;
      tr.innerHTML = `
        <td><input type="checkbox" class="sel-contact" ${state.selectedContacts.has(c.id) ? "checked" : ""} /></td>
        <td>${numCell}</td>
        <td>${esc(c.name || "-")}</td>
        <td class="muted">${sources || "-"}</td>
        <td><input type="checkbox" class="optout-toggle" ${c.optedOut ? "checked" : ""} /></td>`;
      tr.querySelector(".sel-contact").addEventListener("change", (ev) => {
        if (ev.target.checked) state.selectedContacts.add(c.id);
        else state.selectedContacts.delete(c.id);
        updateSelectedCount();
      });
      tr.querySelector(".optout-toggle").addEventListener("change", async (ev) => {
        try {
          await api("/api/contacts/optout", {
            method: "POST",
            body: JSON.stringify({ contactId: c.id, optedOut: ev.target.checked })
          });
        } catch (e) {
          alert(e.message);
          ev.target.checked = !ev.target.checked;
        }
      });
      tbody.appendChild(tr);
    }
  } catch (e) {
    $("contactsCount").textContent = e.message;
  }
}
$("loadContactsBtn").addEventListener("click", loadContacts);

$("exportCsvBtn").addEventListener("click", async () => {
  try {
    const params = new URLSearchParams({
      search: $("contactSearch").value.trim(),
      optedOut: $("contactOptFilter").value
    });
    const res = await fetch(`/api/contacts/export?${params}`);
    if (res.status === 401) {
      location.href = "/login.html";
      return;
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "Export failed");
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "whatsapp-contacts.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert(e.message);
  }
});

$("messageSelectedBtn").addEventListener("click", () => {
  if (!state.selectedContacts.size) {
    alert("Tick the checkboxes next to the contacts you want to message first.");
    return;
  }
  const radio = document.querySelector('input[name="audience"][value="selected"]');
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
  document.querySelector('.tabs button[data-tab="bulk"]').click();
  updateSelectedCount();
});

/* ---------- bulk campaigns ---------- */
document.querySelectorAll('input[name="audience"]').forEach((r) => {
  r.addEventListener("change", () => {
    const val = document.querySelector('input[name="audience"]:checked').value;
    $("campGroupPicker").style.display = val === "groups" ? "grid" : "none";
    $("campListWrap").style.display = val === "list" ? "block" : "none";
    $("campManualWrap").style.display = val === "manual" ? "block" : "none";
  });
});

async function campaignPayload(dryRun) {
  const picked = document.querySelector('input[name="audience"]:checked').value;
  // "selected" is a dashboard-only label; the server knows it as "ids".
  const audienceType = picked === "selected" ? "ids" : picked;
  const startVal = $("campStart").value;
  return {
    name: $("campName").value.trim(),
    message: $("campMessage").value,
    audienceType,
    groupJids: picked === "groups" ? pickedGroups($("campGroupPicker")) : [],
    contactIds: picked === "selected" ? [...state.selectedContacts] : [],
    listId: picked === "list" ? $("campList").value : null,
    manualText: picked === "manual" ? $("campManualNumbers").value : "",
    imageData: await getImageData("campImage"),
    followUp: dryRun ? null : {
      delayHours: $("fuDelay").value ? Number($("fuDelay").value) : null,
      message: $("fuMessage").value,
      imageData: await getImageData("fuImage")
    },
    dryRun,
    scheduledStartAt: startVal ? new Date(startVal).toISOString() : null
  };
}

$("campPreviewBtn").addEventListener("click", async () => {
  $("campError").textContent = "";
  $("campPreview").textContent = "Checking…";
  try {
    const r = await api("/api/campaigns", { method: "POST", body: JSON.stringify(await campaignPayload(true)) });
    $("campPreview").textContent = `${r.recipients} recipients would receive this (sample: ${r.sample.join(", ") || "none"})`;
  } catch (e) {
    $("campError").textContent = e.message;
    $("campPreview").textContent = "";
  }
});

$("campCreateBtn").addEventListener("click", async () => {
  if (editState.type === "campaign") {
    saveEditCampaign();
    return;
  }
  $("campError").textContent = "";
  try {
    await api("/api/campaigns", { method: "POST", body: JSON.stringify(await campaignPayload(false)) });
    $("campName").value = "";
    $("campMessage").value = "";
    $("campImage").value = "";
    $("campStart").value = "";
    $("campPreview").textContent = "Campaign queued.";
    loadCampaigns();
  } catch (e) {
    $("campError").textContent = e.message;
  }
});

async function loadCampaigns() {
  try {
    const { campaigns } = await api("/api/campaigns");
    const tbody = $("campaignsTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const c of campaigns) {
      const p = c.progress || { total: 0, sent: 0, failed: 0, skipped: 0 };
      const pct = p.total ? Math.round((p.sent / p.total) * 100) : 0;
      const tr = document.createElement("tr");
      const fuLine = c.followUp ? `<br /><span class="muted">↳ follow-up in ${esc(String(c.followUp.delayHours))}h (non-repliers)</span>` : "";
      tr.innerHTML = `
        <td>${esc(c.name)}<br /><span class="muted">${esc(c.audienceType)}${c.listId ? " · " + esc(listName(c.listId)) : ""}${c.scheduledStartAt ? " · starts " + esc(new Date(c.scheduledStartAt).toLocaleString()) : ""}</span>${fuLine}</td>
        <td>${esc(c.status)}${c.error ? `<br /><span class="error">${esc(c.error)}</span>` : ""}${c.cooldownMsg ? `<br /><span class="muted">⏸ ${esc(c.cooldownMsg)}</span>` : ""}</td>
        <td><div class="progress"><div style="width:${pct}%"></div></div><span class="muted">${p.sent}/${p.total} sent · ${p.failed} failed · ${p.skipped} skipped</span></td>
        <td></td>`;
      const actions = tr.lastElementChild;
      if (c.status === "queued" || c.status === "paused") {
        const e = document.createElement("button");
        e.textContent = "Edit";
        e.addEventListener("click", () => startEditCampaign(c.id));
        actions.appendChild(e);
        actions.appendChild(document.createTextNode(" "));
      }
      if (c.status === "running" || c.status === "queued") {
        const b = document.createElement("button");
        b.textContent = "Pause";
        b.addEventListener("click", async () => {
          await api(`/api/campaigns/${c.id}/pause`, { method: "POST" });
          loadCampaigns();
        });
        actions.appendChild(b);
      } else if (c.status === "paused") {
        const b = document.createElement("button");
        b.textContent = "Resume";
        b.addEventListener("click", async () => {
          await api(`/api/campaigns/${c.id}/resume`, { method: "POST" });
          loadCampaigns();
        });
        actions.appendChild(b);
      } else {
        actions.innerHTML = '<span class="muted">—</span>';
      }
      tbody.appendChild(tr);
    }
  } catch (e) {
    // leave table as-is on error
  }
}
$("loadCampaignsBtn").addEventListener("click", loadCampaigns);

/* ---------- schedules ---------- */
function defaultScheduleDates() {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  $("schedStart").value = fmt(now);
  $("schedEnd").value = fmt(new Date(now.getTime() + 14 * 86400000));
  $("stStart").value = fmt(now);
  $("stEnd").value = fmt(new Date(now.getTime() + 14 * 86400000));
}
defaultScheduleDates();

document.querySelectorAll('input[name="recur"]').forEach((r) => {
  r.addEventListener("change", () => {
    const val = document.querySelector('input[name="recur"]:checked').value;
    $("schedDaysWrap").style.display = val === "weekly" ? "flex" : "none";
  });
});

$("schedCreateBtn").addEventListener("click", async () => {
  if (editState.type === "schedule") {
    saveEditSchedule();
    return;
  }
  $("schedError").textContent = "";
  $("schedMsg").textContent = "";
  const times = $("schedTimes").value.split(",").map((t) => t.trim()).filter(Boolean);
  const recurrence = document.querySelector('input[name="recur"]:checked').value;
  const days = [...document.querySelectorAll(".sched-day:checked")].map((c) => Number(c.value));
  try {
    await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        name: $("schedName").value.trim(),
        message: $("schedMessage").value,
        groupJids: pickedGroups($("schedGroupPicker")),
        imageData: await getImageData("schedImage"),
        times,
        startDate: $("schedStart").value,
        endDate: $("schedEnd").value,
        timezone: $("schedTz").value.trim(),
        recurrence,
        days,
        active: true
      })
    });
    $("schedMsg").textContent = "Schedule created.";
    $("schedName").value = "";
    $("schedMessage").value = "";
    $("schedImage").value = "";
    $("schedTimes").value = "";
    loadSchedules();
  } catch (e) {
    $("schedError").textContent = e.message;
  }
});

async function loadSchedules() {
  try {
    const { schedules } = await api("/api/schedules");
    const tbody = $("schedulesTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const s of schedules) {
      const groups = s.groupJids.map((g) => esc(state.groupNames[g] || g)).join(", ");
      const recurLabel = s.recurrence === "weekly"
        ? " · weekly (" + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].filter((_, i) => (s.days || []).includes(i)).join(", ") + ")"
        : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(s.name)}<br /><span class="muted">${recurLabel.trim().replace(/^· /, "")}</span></td>
        <td class="muted">${groups}</td>
        <td>${s.times.map(esc).join(", ")}</td>
        <td class="muted">${esc(s.startDate)} → ${esc(s.endDate)}<br />${esc(s.timezone)}</td>
        <td>${s.active ? "on" : "off"}</td>
        <td></td>`;
      const actions = tr.lastElementChild;
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditSchedule(s.id));
      actions.appendChild(edit);
      actions.appendChild(document.createTextNode(" "));
      const toggle = document.createElement("button");
      toggle.textContent = s.active ? "Pause" : "Activate";
      toggle.addEventListener("click", async () => {
        await api(`/api/schedules/${s.id}/toggle`, { method: "POST" });
        loadSchedules();
      });
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "danger";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete schedule "${s.name}"?`)) return;
        await api(`/api/schedules/${s.id}`, { method: "DELETE" });
        loadSchedules();
      });
      actions.appendChild(toggle);
      actions.appendChild(document.createTextNode(" "));
      actions.appendChild(del);
      tbody.appendChild(tr);
    }
  } catch (e) {
    // leave table as-is on error
  }
}
$("loadSchedulesBtn").addEventListener("click", loadSchedules);

/* ---------- logs & settings ---------- */
async function loadLogs() {
  try {
    const params = new URLSearchParams({ kind: $("logKind").value, limit: "100" });
    const { logs } = await api(`/api/logs?${params}`);
    const tbody = $("logsTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const l of logs) {
      const tr = document.createElement("tr");
      const detail = l.error ? `<span class="error">${esc(l.error)}</span>` : esc(l.message || "");
      tr.innerHTML = `
        <td class="muted">${esc(new Date(l.ts).toLocaleString())}</td>
        <td>${esc(l.kind)}</td>
        <td class="muted">${esc(l.target || "-")}</td>
        <td>${l.ok ? "ok" : "failed"} ${detail ? "<br />" + detail : ""}</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) {
    // leave table as-is on error
  }
}
$("loadLogsBtn").addEventListener("click", loadLogs);

async function loadSettings() {
  try {
    const { settings } = await api("/api/settings");
    $("setDmDelay").value = settings.dmDelayMs;
    $("setDmCap").value = settings.dmDailyCap;
    $("setDmHourlyCap").value = settings.dmHourlyCap ?? 0;
    $("setDmHourlyCooldownMin").value = settings.dmHourlyCooldownMin ?? 20;
    $("setDmBatchSize").value = settings.dmBatchSize ?? 0;
    $("setDmBatchCooldownMin").value = settings.dmBatchCooldownMin ?? 20;
    $("setGroupDelay").value = settings.groupDelayMs;
    $("setOptReply").checked = !!settings.autoOptOutReply;
    $("setQuiet").checked = !!settings.quietEnabled;
    $("setQuietStart").value = settings.quietStart;
    $("setQuietEnd").value = settings.quietEnd;
    $("setTz").value = settings.defaultTimezone;
  } catch (e) {
    // token probably missing; ignore
  }
}

$("saveSettingsBtn").addEventListener("click", async () => {
  $("settingsError").textContent = "";
  $("settingsMsg").textContent = "";
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        dmDelayMs: Number($("setDmDelay").value),
        dmDailyCap: Number($("setDmCap").value),
        dmHourlyCap: Number($("setDmHourlyCap").value),
        dmHourlyCooldownMin: Number($("setDmHourlyCooldownMin").value),
        dmBatchSize: Number($("setDmBatchSize").value),
        dmBatchCooldownMin: Number($("setDmBatchCooldownMin").value),
        groupDelayMs: Number($("setGroupDelay").value),
        autoOptOutReply: $("setOptReply").checked,
        quietEnabled: $("setQuiet").checked,
        quietStart: $("setQuietStart").value.trim(),
        quietEnd: $("setQuietEnd").value.trim(),
        defaultTimezone: $("setTz").value.trim()
      })
    });
    $("settingsMsg").textContent = "Saved.";
  } catch (e) {
    $("settingsError").textContent = e.message;
  }
});

/* ---------- manual import ---------- */
$("importNumbersBtn").addEventListener("click", async () => {
  $("importError").textContent = "";
  $("importNumbersMsg").textContent = "Adding…";
  try {
    const r = await api("/api/contacts/import", {
      method: "POST",
      body: JSON.stringify({ numbersText: $("importNumbers").value, source: "manual" })
    });
    $("importNumbersMsg").textContent = `Done: ${r.total} numbers processed, ${r.added} new contacts.`;
    $("importNumbers").value = "";
    loadContacts();
  } catch (e) {
    $("importError").textContent = e.message;
    $("importNumbersMsg").textContent = "";
  }
});

$("importCsvBtn").addEventListener("click", async () => {
  $("importError").textContent = "";
  const file = $("importCsvFile").files[0];
  if (!file) {
    $("importError").textContent = "Choose a CSV file first.";
    return;
  }
  $("importCsvMsg").textContent = "Uploading…";
  try {
    const text = await file.text();
    const r = await api("/api/contacts/import", {
      method: "POST",
      body: JSON.stringify({ csvText: text, source: "csv" })
    });
    $("importCsvMsg").textContent = `Done: ${r.total} numbers processed, ${r.added} new contacts.`;
    $("importCsvFile").value = "";
    loadContacts();
  } catch (e) {
    $("importError").textContent = e.message;
    $("importCsvMsg").textContent = "";
  }
});

/* ---------- test send ---------- */
$("testSendBtn").addEventListener("click", async () => {
  $("testSendError").textContent = "";
  $("testSendMsg").textContent = "Sending…";
  try {
    await api("/api/test-send", {
      method: "POST",
      body: JSON.stringify({
        digits: $("testNumber").value,
        message: $("testMessage").value,
        imageData: await getImageData("testImage")
      })
    });
    $("testSendMsg").textContent = "Sent. Check the phone for the message.";
    $("testImage").value = "";
  } catch (e) {
    $("testSendError").textContent = e.message;
    $("testSendMsg").textContent = "";
  }
});

/* ---------- spintax preview ---------- */
async function previewSpinVariations(message, outEl, errEl) {
  errEl.textContent = "";
  outEl.innerHTML = "";
  try {
    const r = await api("/api/spin-preview", {
      method: "POST",
      body: JSON.stringify({ message })
    });
    outEl.innerHTML = r.samples.map((s) => `<div>• ${esc(s)}</div>`).join("");
  } catch (e) {
    errEl.textContent = e.message;
  }
}

$("spinPreviewBtn").addEventListener("click", () => {
  previewSpinVariations($("campMessage").value, $("spinPreviewOut"), $("campError"));
});

$("schedSpinPreviewBtn").addEventListener("click", () => {
  previewSpinVariations($("schedMessage").value, $("schedSpinPreviewOut"), $("schedError"));
});

/* ---------- contact lists ---------- */
function listName(id) {
  const l = state.lists.find((x) => x.id === id);
  return l ? l.name : id;
}

async function loadLists() {
  try {
    const { lists } = await api("/api/lists");
    state.lists = lists;
    renderLists();
    // Populate every list dropdown.
    for (const selId of ["campList", "contactListFilter", "bulkListSelect"]) {
      const sel = $(selId);
      const keep = sel.value;
      sel.innerHTML = selId === "contactListFilter"
        ? '<option value="">All lists</option>'
        : selId === "bulkListSelect"
          ? '<option value="">Choose a list…</option>'
          : "";
      for (const l of lists) {
        const opt = document.createElement("option");
        opt.value = l.id;
        opt.textContent = `${l.name} (${l.count})`;
        sel.appendChild(opt);
      }
      if (keep) sel.value = keep;
    }
  } catch (e) {
    // leave as-is on error
  }
}

function renderLists() {
  const tbody = $("listsTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const l of state.lists) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(l.name)}</td><td class="muted">${l.count}</td><td></td>`;
    const edit = document.createElement("button");
    edit.textContent = "Rename";
    edit.addEventListener("click", () => startEditList(l.id));
    tr.lastElementChild.appendChild(edit);
    tr.lastElementChild.appendChild(document.createTextNode(" "));
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete list "${l.name}"? Contacts stay, they just leave the list.`)) return;
      try {
        await api(`/api/lists/${l.id}`, { method: "DELETE" });
        loadLists();
      } catch (e) {
        $("listError").textContent = e.message;
      }
    });
    tr.lastElementChild.appendChild(del);
    tbody.appendChild(tr);
  }
}

$("createListBtn").addEventListener("click", async () => {
  if (editState.type === "list") {
    saveEditList();
    return;
  }
  $("listError").textContent = "";
  $("listMsg").textContent = "";
  try {
    await api("/api/lists", { method: "POST", body: JSON.stringify({ name: $("newListName").value }) });
    $("newListName").value = "";
    $("listMsg").textContent = "List created.";
    loadLists();
  } catch (e) {
    $("listError").textContent = e.message;
  }
});

async function bulkListAction(mode) {
  $("bulkListMsg").textContent = "";
  const listId = $("bulkListSelect").value;
  if (!listId) { $("bulkListMsg").textContent = "Choose a list first."; return; }
  const ids = [...state.selectedContacts];
  if (!ids.length) { $("bulkListMsg").textContent = "Tick some contacts first."; return; }
  try {
    const r = await api(`/api/lists/${listId}/members`, {
      method: "POST",
      body: JSON.stringify(mode === "add" ? { add: ids } : { remove: ids })
    });
    $("bulkListMsg").textContent = `${r.changed} contact(s) ${mode === "add" ? "added to" : "removed from"} list.`;
    loadLists();
  } catch (e) {
    $("bulkListMsg").textContent = e.message;
  }
}
$("bulkAddToListBtn").addEventListener("click", () => bulkListAction("add"));
$("bulkRemoveFromListBtn").addEventListener("click", () => bulkListAction("remove"));

/* ---------- follow-ups ---------- */
function fuStatusLine(f) {
  const p = f.progress || { total: 0, sent: 0, failed: 0, skipped: 0 };
  const pct = p.total ? Math.round((p.sent / p.total) * 100) : 0;
  const when = f.status === "queued"
    ? ` · fires ${new Date(f.sendAt).toLocaleString()}`
    : "";
  return { p, pct, when };
}

async function loadFollowUps() {
  try {
    const { followUps } = await api("/api/followups");
    const tbody = $("followUpsTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const f of followUps) {
      const { p, pct, when } = fuStatusLine(f);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(f.name)}<br /><span class="muted">${esc(String(f.delayHours))}h after campaign${when}</span></td>
        <td>${esc(f.status)}${f.error ? `<br /><span class="error">${esc(f.error)}</span>` : ""}</td>
        <td><div class="progress"><div style="width:${pct}%"></div></div><span class="muted">${p.sent}/${p.total} sent · ${p.failed} failed · ${p.skipped} skipped</span></td>
        <td></td>`;
      const actions = tr.lastElementChild;
      if (f.status === "queued" || f.status === "paused") {
        const e = document.createElement("button");
        e.textContent = "Edit";
        e.addEventListener("click", () => startEditFollowup(f.id));
        actions.appendChild(e);
        actions.appendChild(document.createTextNode(" "));
      }
      if (f.status === "running" || f.status === "queued") {
        const b = document.createElement("button");
        b.textContent = "Pause";
        b.addEventListener("click", async () => {
          await api(`/api/followups/${f.id}/pause`, { method: "POST" });
          loadFollowUps();
        });
        actions.appendChild(b);
      } else if (f.status === "paused") {
        const b = document.createElement("button");
        b.textContent = "Resume";
        b.addEventListener("click", async () => {
          await api(`/api/followups/${f.id}/resume`, { method: "POST" });
          loadFollowUps();
        });
        actions.appendChild(b);
      } else {
        actions.innerHTML = '<span class="muted">—</span>';
      }
      tbody.appendChild(tr);
    }
  } catch (e) {
    // leave table as-is on error
  }
}
$("loadFollowUpsBtn").addEventListener("click", loadFollowUps);

/* ---------- auto-replies ---------- */
async function loadAutoReplies() {
  try {
    const { rules } = await api("/api/autoreplies");
    const tbody = $("arTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const r of rules) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${esc(r.keyword)}</strong>${r.imagePath ? ' <span class="badge">img</span>' : ""}</td>
        <td class="muted">${esc(r.matchType)}</td>
        <td class="muted">${esc(r.message.slice(0, 80))}${r.message.length > 80 ? "…" : ""}</td>
        <td>${r.active ? '<span class="badge">on</span>' : '<span class="muted">off</span>'}</td>
        <td></td>`;
      const actions = tr.lastElementChild;
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditAutoreply(r.id));
      actions.appendChild(edit);
      actions.appendChild(document.createTextNode(" "));
      const toggle = document.createElement("button");
      toggle.textContent = r.active ? "Turn off" : "Turn on";
      toggle.addEventListener("click", async () => {
        await api(`/api/autoreplies/${r.id}/toggle`, { method: "POST" });
        loadAutoReplies();
      });
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete auto-reply for "${r.keyword}"?`)) return;
        await api(`/api/autoreplies/${r.id}`, { method: "DELETE" });
        loadAutoReplies();
      });
      actions.appendChild(toggle);
      actions.appendChild(document.createTextNode(" "));
      actions.appendChild(del);
      tbody.appendChild(tr);
    }
  } catch (e) {
    // leave table as-is on error
  }
}

$("arAddBtn").addEventListener("click", async () => {
  if (editState.type === "autoreply") {
    saveEditAutoreply();
    return;
  }
  $("arError").textContent = "";
  $("arMsg").textContent = "";
  try {
    await api("/api/autoreplies", {
      method: "POST",
      body: JSON.stringify({
        keyword: $("arKeyword").value,
        matchType: $("arMatchType").value,
        message: $("arMessage").value,
        imageData: await getImageData("arImage")
      })
    });
    $("arKeyword").value = "";
    $("arMessage").value = "";
    $("arImage").value = "";
    $("arMsg").textContent = "Auto-reply added.";
    loadAutoReplies();
  } catch (e) {
    $("arError").textContent = e.message;
  }
});

/* ---------- engage: status scheduler ---------- */
async function loadStatusPosts() {
  try {
    const { posts } = await api("/api/status");
    const tbody = $("statusTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const p of posts) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(p.name)}${p.imagePath ? ' <span class="badge">img</span>' : ""}</td>
        <td>${p.times.map(esc).join(", ")}</td>
        <td class="muted">${esc(p.startDate)} → ${esc(p.endDate)}</td>
        <td>${p.active ? "on" : "off"}</td>
        <td></td>`;
      const actions = tr.lastElementChild;
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditStatus(p.id));
      actions.appendChild(edit);
      actions.appendChild(document.createTextNode(" "));
      const toggle = document.createElement("button");
      toggle.textContent = p.active ? "Pause" : "Activate";
      toggle.addEventListener("click", async () => {
        await api(`/api/status/${p.id}/toggle`, { method: "POST" });
        loadStatusPosts();
      });
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.className = "danger";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete status schedule "${p.name}"?`)) return;
        await api(`/api/status/${p.id}`, { method: "DELETE" });
        loadStatusPosts();
      });
      actions.appendChild(toggle);
      actions.appendChild(document.createTextNode(" "));
      actions.appendChild(del);
      tbody.appendChild(tr);
    }
  } catch (e) { /* leave as-is */ }
}

$("stCreateBtn").addEventListener("click", async () => {
  if (editState.type === "status") {
    saveEditStatus();
    return;
  }
  $("stError").textContent = "";
  $("stMsg").textContent = "";
  const times = $("stTimes").value.split(",").map((t) => t.trim()).filter(Boolean);
  try {
    await api("/api/status", {
      method: "POST",
      body: JSON.stringify({
        name: $("stName").value.trim(),
        message: $("stMessage").value,
        imageData: await getImageData("stImage"),
        times,
        startDate: $("stStart").value,
        endDate: $("stEnd").value,
        timezone: $("stTz").value.trim()
      })
    });
    $("stMsg").textContent = "Status schedule created.";
    $("stName").value = ""; $("stMessage").value = ""; $("stImage").value = ""; $("stTimes").value = "";
    loadStatusPosts();
  } catch (e) {
    $("stError").textContent = e.message;
  }
});

/* ---------- engage: polls ---------- */
$("pollSendBtn").addEventListener("click", async () => {
  $("pollError").textContent = "";
  $("pollMsg").textContent = "Sending…";
  const options = $("pollOpts").value.split("\n").map((o) => o.trim()).filter(Boolean);
  try {
    const r = await api("/api/polls/send", {
      method: "POST",
      body: JSON.stringify({
        question: $("pollQ").value,
        options,
        groupJids: pickedGroups($("pollGroupPicker"))
      })
    });
    $("pollMsg").textContent = `Poll sent to ${r.sent} group(s).`;
    $("pollQ").value = ""; $("pollOpts").value = "";
  } catch (e) {
    $("pollError").textContent = e.message;
    $("pollMsg").textContent = "";
  }
});

/* ---------- engage: welcome messages ---------- */
async function loadWelcomeRules() {
  try {
    const { rules } = await api("/api/welcome");
    const tbody = $("welcomeTable").querySelector("tbody");
    tbody.innerHTML = "";
    for (const r of rules) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="muted">${esc(state.groupNames[r.groupJid] || r.groupJid)}</td>
        <td>${esc(r.via === "dm" ? "DM" : "Group")}</td>
        <td class="muted">${esc(r.message.slice(0, 80))}${r.message.length > 80 ? "…" : ""}</td>
        <td>${r.active ? '<span class="badge">on</span>' : '<span class="muted">off</span>'}</td>
        <td></td>`;
      const actions = tr.lastElementChild;
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => startEditWelcome(r.id));
      actions.appendChild(edit);
      actions.appendChild(document.createTextNode(" "));
      const toggle = document.createElement("button");
      toggle.textContent = r.active ? "Turn off" : "Turn on";
      toggle.addEventListener("click", async () => {
        await api(`/api/welcome/${r.id}/toggle`, { method: "POST" });
        loadWelcomeRules();
      });
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this welcome rule?")) return;
        await api(`/api/welcome/${r.id}`, { method: "DELETE" });
        loadWelcomeRules();
      });
      actions.appendChild(toggle);
      actions.appendChild(document.createTextNode(" "));
      actions.appendChild(del);
      tbody.appendChild(tr);
    }
  } catch (e) { /* leave as-is */ }
}

$("welAddBtn").addEventListener("click", async () => {
  if (editState.type === "welcome") {
    saveEditWelcome();
    return;
  }
  $("welError").textContent = "";
  $("welMsg").textContent = "";
  try {
    await api("/api/welcome", {
      method: "POST",
      body: JSON.stringify({
        groupJid: $("welGroup").value,
        via: $("welVia").value,
        message: $("welMessage").value,
        imageData: await getImageData("welImage")
      })
    });
    $("welMsg").textContent = "Welcome rule added.";
    $("welMessage").value = ""; $("welImage").value = "";
    loadWelcomeRules();
  } catch (e) {
    $("welError").textContent = e.message;
  }
});

/* ---------- engage: missed-call reply ---------- */
async function loadCallReply() {
  try {
    const { callReply } = await api("/api/callreply");
    $("callActive").checked = !!callReply.active;
    $("callMessage").value = callReply.message || "";
  } catch (e) { /* leave as-is */ }
}

$("callSaveBtn").addEventListener("click", async () => {
  $("callError").textContent = "";
  $("callMsg").textContent = "";
  try {
    await api("/api/callreply", {
      method: "POST",
      body: JSON.stringify({ active: $("callActive").checked, message: $("callMessage").value })
    });
    $("callMsg").textContent = "Saved.";
  } catch (e) {
    $("callError").textContent = e.message;
  }
});

/* ---------- engage: wa.me generator ---------- */
$("waGenBtn").addEventListener("click", () => {
  const num = $("waNumber").value.replace(/\D/g, "");
  const text = $("waText").value.trim();
  if (!num) { $("waOut").textContent = "Enter a number first."; return; }
  const url = "https://wa.me/" + num + (text ? "?text=" + encodeURIComponent(text) : "");
  $("waOut").innerHTML = "";
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.textContent = url;
  const copy = document.createElement("button");
  copy.textContent = "Copy";
  copy.addEventListener("click", () => navigator.clipboard.writeText(url).then(() => { copy.textContent = "Copied!"; }));
  $("waOut").appendChild(a);
  $("waOut").appendChild(document.createTextNode(" "));
  $("waOut").appendChild(copy);
});

/* ---------- edit mode ---------- */
const editState = { type: null, id: null };

function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setRemoveImageWrap(wrapId, boxId, hasImage) {
  $(wrapId).style.display = hasImage ? "" : "none";
  $(boxId).checked = false;
}

function cancelEdit() {
  if (!editState.type) return;
  const t = editState.type;
  editState.type = null;
  editState.id = null;
  if (t === "campaign") resetCampaignForm();
  else if (t === "schedule") resetScheduleForm();
  else if (t === "autoreply") { $("arAddBtn").textContent = "Add auto-reply"; $("arCancelBtn").style.display = "none"; $("arKeyword").value = ""; $("arMessage").value = ""; $("arImage").value = ""; setRemoveImageWrap("arRemoveImageWrap", "arRemoveImage", false); }
  else if (t === "welcome") { $("welAddBtn").textContent = "Add welcome rule"; $("welCancelBtn").style.display = "none"; $("welMessage").value = ""; $("welImage").value = ""; setRemoveImageWrap("welRemoveImageWrap", "welRemoveImage", false); }
  else if (t === "status") { $("stCreateBtn").textContent = "Create status schedule"; $("stCancelBtn").style.display = "none"; $("stName").value = ""; $("stMessage").value = ""; $("stImage").value = ""; setRemoveImageWrap("stRemoveImageWrap", "stRemoveImage", false); }
  else if (t === "list") { $("createListBtn").textContent = "Create list"; $("listCancelBtn").style.display = "none"; $("newListName").value = ""; }
  else if (t === "followup") { $("fuEditCard").style.display = "none"; }
}

function resetCampaignForm() {
  $("campCreateBtn").textContent = "Create & queue campaign";
  $("campCancelBtn").style.display = "none";
  $("campName").value = ""; $("campMessage").value = ""; $("campImage").value = "";
  $("campStart").value = ""; $("fuDelay").value = ""; $("fuMessage").value = ""; $("fuImage").value = "";
  setRemoveImageWrap("campRemoveImageWrap", "campRemoveImage", false);
  setRemoveImageWrap("fuRemoveImageWrap", "fuRemoveImage", false);
  document.querySelectorAll('input[name="audience"]').forEach((r) => { r.disabled = false; });
  $("campPreviewBtn").disabled = false;
}

function resetScheduleForm() {
  $("schedCreateBtn").textContent = "Create schedule";
  $("schedCancelBtn").style.display = "none";
  $("schedName").value = ""; $("schedMessage").value = ""; $("schedImage").value = ""; $("schedTimes").value = "";
  setRemoveImageWrap("schedRemoveImageWrap", "schedRemoveImage", false);
  document.querySelector('input[name="recur"][value="once"]').checked = true;
  $("schedDaysWrap").style.display = "none";
  document.querySelectorAll(".sched-day").forEach((c) => { c.checked = false; });
  defaultScheduleDates();
}

// --- campaigns ---
async function startEditCampaign(id) {
  cancelEdit();
  const { campaigns } = await api("/api/campaigns");
  const c = campaigns.find((x) => x.id === id);
  if (!c) return;
  if (!["queued", "paused"].includes(c.status)) {
    alert(`Only queued or paused campaigns can be edited (this one is ${c.status}).`);
    return;
  }
  editState.type = "campaign";
  editState.id = id;
  $("campName").value = c.name;
  $("campMessage").value = c.message;
  $("campStart").value = isoToLocalInput(c.scheduledStartAt);
  $("fuDelay").value = c.followUp?.delayHours || "";
  $("fuMessage").value = c.followUp?.message || "";
  setRemoveImageWrap("campRemoveImageWrap", "campRemoveImage", !!c.imagePath);
  setRemoveImageWrap("fuRemoveImageWrap", "fuRemoveImage", !!c.followUp?.imagePath);
  document.querySelectorAll('input[name="audience"]').forEach((r) => { r.disabled = true; });
  $("campPreviewBtn").disabled = true;
  $("campCreateBtn").textContent = "Save changes";
  $("campCancelBtn").style.display = "";
  document.querySelector('.tabs button[data-tab="bulk"]').click();
  $("campName").focus();
}

async function saveEditCampaign() {
  const id = editState.id;
  $("campError").textContent = "";
  const fuMsg = $("fuMessage").value.trim();
  try {
    await api(`/api/campaigns/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("campName").value.trim(),
        message: $("campMessage").value,
        scheduledStartAt: $("campStart").value ? new Date($("campStart").value).toISOString() : null,
        imageData: await getImageData("campImage"),
        removeImage: $("campRemoveImage").checked,
        followUp: fuMsg ? {
          delayHours: $("fuDelay").value ? Number($("fuDelay").value) : null,
          message: $("fuMessage").value,
          imageData: await getImageData("fuImage"),
          removeImage: $("fuRemoveImage").checked
        } : null
      })
    });
    $("campPreview").textContent = "Campaign updated.";
    cancelEdit();
    loadCampaigns();
    loadFollowUps();
  } catch (e) {
    $("campError").textContent = e.message;
  }
}

// --- schedules ---
async function startEditSchedule(id) {
  cancelEdit();
  const { schedules } = await api("/api/schedules");
  const s = schedules.find((x) => x.id === id);
  if (!s) return;
  editState.type = "schedule";
  editState.id = id;
  $("schedName").value = s.name;
  $("schedMessage").value = s.message;
  $("schedTimes").value = (s.times || []).join(", ");
  $("schedStart").value = s.startDate || "";
  $("schedEnd").value = s.endDate || "";
  $("schedTz").value = s.timezone || "Africa/Accra";
  setRemoveImageWrap("schedRemoveImageWrap", "schedRemoveImage", !!s.imagePath);
  const recur = s.recurrence === "weekly" ? "weekly" : "once";
  document.querySelector(`input[name="recur"][value="${recur}"]`).checked = true;
  $("schedDaysWrap").style.display = recur === "weekly" ? "flex" : "none";
  document.querySelectorAll(".sched-day").forEach((c) => { c.checked = (s.days || []).includes(Number(c.value)); });
  // group picker
  const wanted = new Set(s.groupJids || []);
  $("schedGroupPicker").querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = wanted.has(c.value); });
  $("schedCreateBtn").textContent = "Save changes";
  $("schedCancelBtn").style.display = "";
  document.querySelector('.tabs button[data-tab="schedules"]').click();
  $("schedName").focus();
}

async function saveEditSchedule() {
  const id = editState.id;
  $("schedError").textContent = "";
  const times = $("schedTimes").value.split(",").map((t) => t.trim()).filter(Boolean);
  const recurrence = document.querySelector('input[name="recur"]:checked').value;
  const days = [...document.querySelectorAll(".sched-day:checked")].map((c) => Number(c.value));
  try {
    await api(`/api/schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("schedName").value.trim(),
        message: $("schedMessage").value,
        times,
        startDate: $("schedStart").value,
        endDate: $("schedEnd").value,
        timezone: $("schedTz").value.trim(),
        recurrence,
        days,
        groupJids: pickedGroups($("schedGroupPicker")),
        imageData: await getImageData("schedImage"),
        removeImage: $("schedRemoveImage").checked
      })
    });
    $("schedMsg").textContent = "Schedule updated.";
    cancelEdit();
    loadSchedules();
  } catch (e) {
    $("schedError").textContent = e.message;
  }
}

/* ---------- edit: auto-replies, welcome, status, lists, follow-ups ---------- */
async function startEditAutoreply(id) {
  cancelEdit();
  const { rules } = await api("/api/autoreplies");
  const r = rules.find((x) => x.id === id);
  if (!r) return;
  editState.type = "autoreply";
  editState.id = id;
  $("arKeyword").value = r.keyword;
  $("arMatchType").value = r.matchType;
  $("arMessage").value = r.message;
  setRemoveImageWrap("arRemoveImageWrap", "arRemoveImage", !!r.imagePath);
  $("arAddBtn").textContent = "Save changes";
  $("arCancelBtn").style.display = "";
  document.querySelector('.tabs button[data-tab="autoreplies"]').click();
  $("arKeyword").focus();
}

async function saveEditAutoreply() {
  const id = editState.id;
  $("arError").textContent = "";
  try {
    await api(`/api/autoreplies/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        keyword: $("arKeyword").value,
        matchType: $("arMatchType").value,
        message: $("arMessage").value,
        imageData: await getImageData("arImage"),
        removeImage: $("arRemoveImage").checked
      })
    });
    $("arMsg").textContent = "Auto-reply updated.";
    cancelEdit();
    loadAutoReplies();
  } catch (e) {
    $("arError").textContent = e.message;
  }
}

async function startEditWelcome(id) {
  cancelEdit();
  const { rules } = await api("/api/welcome");
  const r = rules.find((x) => x.id === id);
  if (!r) return;
  editState.type = "welcome";
  editState.id = id;
  $("welGroup").value = r.groupJid;
  $("welVia").value = r.via;
  $("welMessage").value = r.message;
  setRemoveImageWrap("welRemoveImageWrap", "welRemoveImage", !!r.imagePath);
  $("welAddBtn").textContent = "Save changes";
  $("welCancelBtn").style.display = "";
  document.querySelector('.tabs button[data-tab="engage"]').click();
  $("welMessage").focus();
}

async function saveEditWelcome() {
  const id = editState.id;
  $("welError").textContent = "";
  try {
    await api(`/api/welcome/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupJid: $("welGroup").value,
        via: $("welVia").value,
        message: $("welMessage").value,
        imageData: await getImageData("welImage"),
        removeImage: $("welRemoveImage").checked
      })
    });
    $("welMsg").textContent = "Welcome rule updated.";
    cancelEdit();
    loadWelcomeRules();
  } catch (e) {
    $("welError").textContent = e.message;
  }
}

async function startEditStatus(id) {
  cancelEdit();
  const { posts } = await api("/api/status");
  const p = posts.find((x) => x.id === id);
  if (!p) return;
  editState.type = "status";
  editState.id = id;
  $("stName").value = p.name;
  $("stMessage").value = p.message;
  $("stTimes").value = (p.times || []).join(", ");
  $("stStart").value = p.startDate || "";
  $("stEnd").value = p.endDate || "";
  $("stTz").value = p.timezone || "Africa/Accra";
  setRemoveImageWrap("stRemoveImageWrap", "stRemoveImage", !!p.imagePath);
  $("stCreateBtn").textContent = "Save changes";
  $("stCancelBtn").style.display = "";
  document.querySelector('.tabs button[data-tab="engage"]').click();
  $("stName").focus();
}

async function saveEditStatus() {
  const id = editState.id;
  $("stError").textContent = "";
  const times = $("stTimes").value.split(",").map((t) => t.trim()).filter(Boolean);
  try {
    await api(`/api/status/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("stName").value.trim(),
        message: $("stMessage").value,
        times,
        startDate: $("stStart").value,
        endDate: $("stEnd").value,
        timezone: $("stTz").value.trim(),
        imageData: await getImageData("stImage"),
        removeImage: $("stRemoveImage").checked
      })
    });
    $("stMsg").textContent = "Status schedule updated.";
    cancelEdit();
    loadStatusPosts();
  } catch (e) {
    $("stError").textContent = e.message;
  }
}

function startEditList(id) {
  cancelEdit();
  const l = state.lists.find((x) => x.id === id);
  if (!l) return;
  editState.type = "list";
  editState.id = id;
  $("newListName").value = l.name;
  $("createListBtn").textContent = "Save";
  $("listCancelBtn").style.display = "";
  document.querySelector('.tabs button[data-tab="contacts"]').click();
  $("newListName").focus();
}

async function saveEditList() {
  const id = editState.id;
  $("listError").textContent = "";
  try {
    await api(`/api/lists/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: $("newListName").value })
    });
    $("listMsg").textContent = "List renamed.";
    cancelEdit();
    loadLists();
  } catch (e) {
    $("listError").textContent = e.message;
  }
}

async function startEditFollowup(id) {
  cancelEdit();
  const { followUps } = await api("/api/followups");
  const f = followUps.find((x) => x.id === id);
  if (!f) return;
  if (!["queued", "paused"].includes(f.status)) {
    alert(`Only queued or paused follow-ups can be edited (this one is ${f.status}).`);
    return;
  }
  editState.type = "followup";
  editState.id = id;
  $("fuEditMessage").value = f.message;
  $("fuEditSendAt").value = isoToLocalInput(f.sendAt);
  $("fuEditRemoveImage").checked = false;
  $("fuEditImage").value = "";
  $("fuEditMsg").textContent = f.imagePath ? "This follow-up has an image attached." : "";
  $("fuEditError").textContent = "";
  $("fuEditCard").style.display = "";
  document.querySelector('.tabs button[data-tab="bulk"]').click();
  $("fuEditCard").scrollIntoView();
}

async function saveEditFollowup() {
  const id = editState.id;
  $("fuEditError").textContent = "";
  try {
    await api(`/api/followups/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        message: $("fuEditMessage").value,
        sendAt: $("fuEditSendAt").value ? new Date($("fuEditSendAt").value).toISOString() : undefined,
        imageData: await getImageData("fuEditImage"),
        removeImage: $("fuEditRemoveImage").checked
      })
    });
    $("fuEditMsg").textContent = "Follow-up updated.";
    cancelEdit();
    loadFollowUps();
  } catch (e) {
    $("fuEditError").textContent = e.message;
  }
}

$("fuEditSaveBtn").addEventListener("click", saveEditFollowup);
$("fuEditCancelBtn").addEventListener("click", cancelEdit);

// Cancel buttons for every edit form.
for (const btnId of ["campCancelBtn", "schedCancelBtn", "arCancelBtn", "welCancelBtn", "stCancelBtn", "listCancelBtn"]) {
  $(btnId).addEventListener("click", cancelEdit);
}

/* ---------- init ---------- */
if (getToken()) {
  loadStatus();
  loadSettings();
  loadLists();
  loadAutoReplies();
  loadStatusPosts();
  loadWelcomeRules();
  loadCallReply();
}
