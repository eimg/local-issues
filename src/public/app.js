const PAGE_SIZE = 25;

const state = {
  issues: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0,
  deliveries: [],
  config: null,
  selectedId: null,
  statusFilter: "",
  labelFilter: "",
  watchTimer: null,
};

const WATCH_INTERVAL_MS = 2000;
const WATCH_TIMEOUT_MS = 120_000;

const els = {
  issueList: document.getElementById("issue-list"),
  deliveryList: document.getElementById("delivery-list"),
  emptyState: document.getElementById("empty-state"),
  issueDetail: document.getElementById("issue-detail"),
  issueNumber: document.getElementById("issue-number"),
  detailTitle: document.getElementById("detail-title"),
  detailBody: document.getElementById("detail-body"),
  detailLabels: document.getElementById("detail-labels"),
  detailMeta: document.getElementById("detail-meta"),
  commentList: document.getElementById("comment-list"),
  commentForm: document.getElementById("comment-form"),
  commentBody: document.getElementById("comment-body"),
  saveBtn: document.getElementById("save-btn"),
  triggerBtn: document.getElementById("trigger-btn"),
  toggleStatusBtn: document.getElementById("toggle-status-btn"),
  deleteBtn: document.getElementById("delete-btn"),
  newIssueBtn: document.getElementById("new-issue-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  refreshDeliveriesBtn: document.getElementById("refresh-deliveries-btn"),
  clearDeliveriesBtn: document.getElementById("clear-deliveries-btn"),
  newIssueDialog: document.getElementById("new-issue-dialog"),
  newIssueForm: document.getElementById("new-issue-form"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsForm: document.getElementById("settings-form"),
  toast: document.getElementById("toast"),
  labelFilter: document.getElementById("label-filter"),
  prevPageBtn: document.getElementById("prev-page-btn"),
  nextPageBtn: document.getElementById("next-page-btn"),
  pageInfo: document.getElementById("page-info"),
  filterBtns: [...document.querySelectorAll(".filter-btn")],
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), 3200);
}

function parseLabelsInput(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function highlightLabel(label) {
  return label === (state.config?.labelFilter || "trigger") ? "trigger" : "";
}

function formatLabels(labels) {
  return labels.map((l) => `<span class="label ${highlightLabel(l)}">${escapeHtml(l)}</span>`).join("");
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

function formatStatus(status) {
  return status === "in_progress" ? "in progress" : status;
}

function statusToggleLabel(status) {
  return status === "closed" ? "Reopen" : "Close";
}

function buildIssuesQuery() {
  const params = new URLSearchParams();
  if (state.statusFilter) params.set("status", state.statusFilter);
  if (state.labelFilter) params.set("label", state.labelFilter);
  params.set("limit", String(state.limit));
  params.set("offset", String(state.offset));
  return `?${params.toString()}`;
}

async function loadConfig() {
  state.config = await api("/api/config");
}

async function loadIssues() {
  const result = await api(`/api/issues${buildIssuesQuery()}`);
  state.issues = result.items;
  state.total = result.total;
  state.limit = result.limit;
  state.offset = result.offset;
  renderIssueList();
  renderPager();
}

async function loadDeliveries() {
  state.deliveries = await api("/api/webhooks/deliveries?limit=30");
  renderDeliveries();
}

function renderPager() {
  const start = state.total === 0 ? 0 : state.offset + 1;
  const end = Math.min(state.offset + state.issues.length, state.total);
  els.pageInfo.textContent =
    state.total === 0 ? "No issues" : `${start}–${end} of ${state.total}`;
  els.prevPageBtn.disabled = state.offset <= 0;
  els.nextPageBtn.disabled = state.offset + state.limit >= state.total;
}

function renderDeliveries() {
  if (state.deliveries.length === 0) {
    els.deliveryList.innerHTML = `<li class="delivery-item"><span class="delivery-meta">No deliveries yet.</span></li>`;
    return;
  }

  els.deliveryList.innerHTML = state.deliveries
    .map((d) => {
      const statusClass = d.success ? "success" : "failed";
      const summary = d.success
        ? `HTTP ${d.statusCode}`
        : d.error || `HTTP ${d.statusCode ?? "error"}`;
      return `
      <li class="delivery-item ${statusClass}" data-id="${d.id}">
        <div class="delivery-item-head">
          <div class="delivery-status ${statusClass}">#${d.issueId} · ${escapeHtml(String(summary))}</div>
          <button type="button" class="btn btn-ghost btn-sm delivery-remove-btn" data-action="delete-delivery" data-id="${d.id}" aria-label="Remove delivery" title="Remove">×</button>
        </div>
        <div class="delivery-meta">${formatTime(d.createdAt)} · ${d.attempts} attempt(s)</div>
        <div class="delivery-meta">${escapeHtml(d.url)}</div>
      </li>`;
    })
    .join("");

  for (const btn of els.deliveryList.querySelectorAll("[data-action='delete-delivery']")) {
    btn.addEventListener("click", () => void removeDelivery(Number(btn.dataset.id)));
  }
}

async function removeDelivery(id) {
  try {
    await api(`/api/webhooks/deliveries/${id}`, { method: "DELETE" });
    showToast("Delivery removed");
    await loadDeliveries();
  } catch (err) {
    showToast(err.message);
  }
}

async function clearAllDeliveries() {
  if (state.deliveries.length === 0) return;
  if (!confirm("Clear all webhook delivery logs?")) return;
  try {
    const result = await api("/api/webhooks/deliveries", { method: "DELETE" });
    showToast(`Cleared ${result.deleted} delivery log(s)`);
    await loadDeliveries();
  } catch (err) {
    showToast(err.message);
  }
}

function renderIssueList() {
  if (state.issues.length === 0) {
    els.issueList.innerHTML = '<li class="issue-empty">No issues yet.</li>';
    return;
  }

  els.issueList.innerHTML = state.issues
    .map(
      (issue) => `
      <li class="issue-item ${issue.id === state.selectedId ? "active" : ""}" data-id="${issue.id}">
        <h3>#${issue.id} ${escapeHtml(issue.title)}</h3>
        <div class="issue-meta">
          <span class="status ${issue.status}">${escapeHtml(formatStatus(issue.status))}</span>
          · ${formatTime(issue.updatedAt)}
        </div>
        <div class="labels">${formatLabels(issue.labels)}</div>
      </li>`
    )
    .join("");

  for (const item of els.issueList.querySelectorAll(".issue-item")) {
    item.addEventListener("click", () => selectIssue(Number(item.dataset.id)));
  }
}

async function fetchIssue(id) {
  try {
    return await api(`/api/issues/${id}`);
  } catch {
    return null;
  }
}

async function resolveIssue(id) {
  return (await fetchIssue(id)) ?? state.issues.find((i) => i.id === id) ?? null;
}

async function selectIssue(id) {
  stopWatchingIssue();
  state.selectedId = id;
  const issue = await resolveIssue(id);
  if (!issue) return;

  els.emptyState.classList.add("hidden");
  els.issueDetail.classList.remove("hidden");
  els.issueNumber.textContent = `Issue #${issue.id}`;
  els.detailTitle.value = issue.title;
  els.detailBody.value = issue.body;
  els.detailLabels.value = issue.labels.join(", ");
  applyIssueMeta(issue);
  els.commentForm.reset();
  renderIssueList();
  void loadComments(id);
  if (issue.status === "open" || issue.status === "in_progress") {
    startWatchingIssue(id, issue.status);
  }
}

function stopWatchingIssue() {
  if (state.watchTimer) {
    clearInterval(state.watchTimer);
    state.watchTimer = null;
  }
}

function applyIssueMeta(issue) {
  els.detailMeta.textContent = `${formatStatus(issue.status)} · updated ${formatTime(issue.updatedAt)}`;
  els.toggleStatusBtn.textContent = statusToggleLabel(issue.status);
}

function syncIssueInList(issue) {
  const index = state.issues.findIndex((i) => i.id === issue.id);
  if (index === -1) return;
  const matchesStatus = !state.statusFilter || state.statusFilter === issue.status;
  const matchesLabel =
    !state.labelFilter || issue.labels.includes(state.labelFilter);
  if (matchesStatus && matchesLabel) {
    state.issues[index] = issue;
  } else {
    state.issues.splice(index, 1);
    state.total = Math.max(0, state.total - 1);
  }
  renderIssueList();
  renderPager();
}

async function refreshSelectedIssue(issueId) {
  const issue = await fetchIssue(issueId);
  if (!issue) return null;
  if (state.selectedId !== issueId) return issue;

  applyIssueMeta(issue);
  syncIssueInList(issue);
  await loadComments(issueId);
  // Keep the list page in sync (filters/pagination), but never trust it for status.
  void loadIssues();
  return issue;
}

function startWatchingIssue(issueId, initialStatus) {
  stopWatchingIssue();
  const startedAt = Date.now();
  let previousStatus = initialStatus ?? "open";
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    if (state.selectedId !== issueId) {
      stopWatchingIssue();
      return;
    }
    if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
      stopWatchingIssue();
      return;
    }

    inFlight = true;
    try {
      const issue = await refreshSelectedIssue(issueId);
      if (!issue) return;
      if (previousStatus !== "in_progress" && issue.status === "in_progress") {
        showToast("Helix picked up this issue");
      }
      if (previousStatus !== "closed" && issue.status === "closed") {
        showToast("Issue closed by webhook");
        stopWatchingIssue();
      }
      previousStatus = issue.status;
    } catch {
      // Ignore transient poll errors.
    } finally {
      inFlight = false;
    }
  };

  void tick();
  state.watchTimer = setInterval(() => void tick(), WATCH_INTERVAL_MS);
}

async function loadComments(issueId) {
  try {
    const comments = await api(`/api/issues/${issueId}/comments`);
    renderComments(comments);
  } catch {
    els.commentList.innerHTML = '<li class="comment-empty">Could not load comments.</li>';
  }
}

function renderComments(comments) {
  if (!comments.length) {
    els.commentList.innerHTML = '<li class="comment-empty">No comments yet.</li>';
    return;
  }

  els.commentList.innerHTML = comments
    .map((comment) => {
      const sourceClass = comment.source === "helix.webhook" ? "helix-webhook" : comment.source;
      const canEdit = comment.source === "user";
      const actions = canEdit
        ? `<div class="comment-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-id="${comment.id}">Edit</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${comment.id}">Delete</button>
          </div>`
        : "";
      return `<li class="comment-item ${escapeHtml(sourceClass)}" data-id="${comment.id}">
        <div class="comment-head">
          <span class="comment-author">${escapeHtml(comment.author)}</span>
          <div class="comment-head-actions">
            <span>${escapeHtml(formatTime(comment.createdAt))}</span>
            ${actions}
          </div>
        </div>
        <p class="comment-body" data-role="body">${escapeHtml(comment.body)}</p>
      </li>`;
    })
    .join("");

  for (const btn of els.commentList.querySelectorAll("[data-action]")) {
    btn.addEventListener("click", () => {
      const commentId = Number(btn.dataset.id);
      if (btn.dataset.action === "edit") startEditComment(commentId);
      if (btn.dataset.action === "delete") void removeComment(commentId);
    });
  }
}

async function addComment(e) {
  e.preventDefault();
  if (!state.selectedId) return;
  const body = els.commentBody.value.trim();
  if (!body) return;

  try {
    const result = await api(`/api/issues/${state.selectedId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, author: "user" }),
    });
    els.commentForm.reset();
    if (result.delivery?.success) showToast("Comment added — Helix continuation started");
    else if (result.delivery) showToast("Comment added — continuation failed");
    else showToast("Comment added");
    await Promise.all([loadComments(state.selectedId), loadIssues(), loadDeliveries()]);
    if (result.delivery?.success) startWatchingIssue(state.selectedId, result.issue?.status ?? "open");
  } catch (err) {
    showToast(err.message);
  }
}

function startEditComment(commentId) {
  const item = els.commentList.querySelector(`.comment-item[data-id="${commentId}"]`);
  if (!item || item.dataset.editing === "true") return;

  const bodyEl = item.querySelector('[data-role="body"]');
  const currentBody = bodyEl.textContent;
  item.dataset.editing = "true";

  const actions = item.querySelector(".comment-actions");
  if (actions) actions.classList.add("hidden");

  bodyEl.replaceWith(
    Object.assign(document.createElement("div"), {
      className: "comment-edit",
      innerHTML: `
        <textarea class="input comment-edit-input" rows="3">${escapeHtml(currentBody)}</textarea>
        <div class="comment-edit-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-edit-action="cancel">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" data-edit-action="save">Save</button>
        </div>`,
    })
  );

  const editRoot = item.querySelector(".comment-edit");
  const textarea = editRoot.querySelector("textarea");
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  editRoot.querySelector('[data-edit-action="cancel"]').addEventListener("click", () => {
    void loadComments(state.selectedId);
  });
  editRoot.querySelector('[data-edit-action="save"]').addEventListener("click", () => {
    void saveComment(commentId, textarea.value);
  });
}

async function saveComment(commentId, body) {
  if (!state.selectedId) return;
  const trimmed = body.trim();
  if (!trimmed) {
    showToast("body cannot be empty");
    return;
  }

  try {
    await api(`/api/issues/${state.selectedId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body: trimmed }),
    });
    showToast("Comment updated");
    await loadComments(state.selectedId);
  } catch (err) {
    showToast(err.message);
  }
}

async function removeComment(commentId) {
  if (!state.selectedId) return;
  if (!confirm("Delete this comment?")) return;

  try {
    await api(`/api/issues/${state.selectedId}/comments/${commentId}`, { method: "DELETE" });
    showToast("Comment deleted");
    await loadComments(state.selectedId);
  } catch (err) {
    showToast(err.message);
  }
}

async function saveSelectedIssue() {
  if (!state.selectedId) return;
  const selectedId = state.selectedId;
  const result = await api(`/api/issues/${selectedId}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: els.detailTitle.value,
      body: els.detailBody.value,
      labels: parseLabelsInput(els.detailLabels.value),
    }),
  });
  if (result.delivery) {
    showToast(result.delivery.success ? "Saved and webhook delivered" : "Saved; webhook failed");
  } else {
    showToast("Issue saved");
  }
  await Promise.all([loadIssues(), loadDeliveries()]);
  await selectIssue(selectedId);
}

async function toggleStatus() {
  if (!state.selectedId) return;
  const current = await resolveIssue(state.selectedId);
  if (!current) return;
  const next = current.status === "closed" ? "open" : "closed";
  const result = await api(`/api/issues/${state.selectedId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: next }),
  });
  if (result.delivery?.success) showToast("Reopened and webhook delivered");
  else showToast(next === "closed" ? "Issue closed" : "Issue reopened");
  await Promise.all([loadIssues(), loadDeliveries()]);
  await selectIssue(state.selectedId);
}

async function sendWebhook() {
  if (!state.selectedId) return;
  const selectedId = state.selectedId;
  const result = await api(`/api/issues/${selectedId}/trigger`, { method: "POST" });
  showToast(result.delivery?.success ? "Webhook delivered" : "Webhook failed — see deliveries");
  await loadDeliveries();
  const issue = await fetchIssue(selectedId);
  if (result.delivery?.success && issue && issue.status !== "closed") {
    startWatchingIssue(selectedId, issue.status);
  }
}

async function deleteSelectedIssue() {
  if (!state.selectedId) return;
  if (!confirm(`Delete issue #${state.selectedId}?`)) return;
  stopWatchingIssue();
  await api(`/api/issues/${state.selectedId}`, { method: "DELETE" });
  state.selectedId = null;
  els.issueDetail.classList.add("hidden");
  els.emptyState.classList.remove("hidden");
  showToast("Issue deleted");
  await loadIssues();
}

function resetToFirstPage() {
  state.offset = 0;
}

els.newIssueBtn.addEventListener("click", () => els.newIssueDialog.showModal());

els.newIssueForm.addEventListener("submit", async (e) => {
  const submitter = e.submitter;
  if (!submitter || submitter.value !== "create") return;
  e.preventDefault();
  const fd = new FormData(els.newIssueForm);
  const result = await api("/api/issues", {
    method: "POST",
    body: JSON.stringify({
      title: fd.get("title"),
      body: fd.get("body") || "",
      labels: parseLabelsInput(String(fd.get("labels") || "")),
    }),
  });
  els.newIssueDialog.close();
  els.newIssueForm.reset();
  if (result.delivery?.success) {
    showToast("Issue created — webhook delivered");
  } else if (result.delivery) {
    showToast("Issue created — webhook failed");
  } else {
    showToast("Issue created");
  }
  resetToFirstPage();
  await Promise.all([loadIssues(), loadDeliveries()]);
  await selectIssue(result.issue.id);
});

els.settingsBtn.addEventListener("click", () => {
  const form = els.settingsForm;
  form.webhookUrl.value = state.config.webhookUrl;
  form.labelFilter.value = state.config.labelFilter;
  form.commentTrigger.value = state.config.commentTrigger;
  form.webhookEnabled.checked = state.config.webhookEnabled;
  els.settingsDialog.showModal();
});

els.settingsForm.addEventListener("submit", async (e) => {
  const submitter = e.submitter;
  if (!submitter || submitter.value !== "save") return;
  e.preventDefault();
  const fd = new FormData(els.settingsForm);
  state.config = await api("/api/config", {
    method: "PATCH",
    body: JSON.stringify({
      webhookUrl: fd.get("webhookUrl"),
      labelFilter: fd.get("labelFilter"),
      commentTrigger: fd.get("commentTrigger"),
      webhookEnabled: fd.get("webhookEnabled") === "on",
    }),
  });
  els.settingsDialog.close();
  showToast("Settings saved");
});

els.saveBtn.addEventListener("click", () => void saveSelectedIssue());
els.triggerBtn.addEventListener("click", () => void sendWebhook());
els.toggleStatusBtn.addEventListener("click", () => void toggleStatus());
els.deleteBtn.addEventListener("click", () => void deleteSelectedIssue());
els.refreshDeliveriesBtn.addEventListener("click", () => void loadDeliveries());
els.clearDeliveriesBtn.addEventListener("click", () => void clearAllDeliveries());
els.commentForm.addEventListener("submit", (e) => void addComment(e));

els.prevPageBtn.addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  void loadIssues();
});

els.nextPageBtn.addEventListener("click", () => {
  if (state.offset + state.limit >= state.total) return;
  state.offset += state.limit;
  void loadIssues();
});

let labelFilterTimer = null;
els.labelFilter.addEventListener("input", () => {
  clearTimeout(labelFilterTimer);
  labelFilterTimer = setTimeout(() => {
    state.labelFilter = els.labelFilter.value.trim();
    resetToFirstPage();
    void loadIssues();
  }, 250);
});

for (const btn of els.filterBtns) {
  btn.addEventListener("click", () => {
    for (const b of els.filterBtns) b.classList.remove("active");
    btn.classList.add("active");
    state.statusFilter = btn.dataset.status || "";
    resetToFirstPage();
    void loadIssues();
  });
}

async function init() {
  await loadConfig();
  await Promise.all([loadIssues(), loadDeliveries()]);
  const deepLink = Number(new URLSearchParams(location.search).get("issue"));
  if (Number.isInteger(deepLink) && deepLink > 0) await selectIssue(deepLink);
}

init().catch((err) => showToast(err.message));
