import { db, validateWorkspace } from "./db.js";
import "./firebase-config.js";

const content = document.querySelector("#page-content");
const formDialog = document.querySelector("#form-modal");
const confirmDialog = document.querySelector("#confirm-modal");
const entityForm = document.querySelector("#entity-form");
const state = {
  clients: [],
  familyMembers: [],
  policies: [],
  followUps: [],
  page: "customers",
  search: "",
  agentFilter: "All",
  detailClientId: null,
  detailTab: "family"
};
let pendingDelete = null;
let toastTimer;

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[character]);

const money = (value) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
}).format(Number(value) || 0);

const cleanPhone = (value = "") => String(value).replace(/[^\d+]/g, "");

const whatsappPhone = (value = "") => {
  let digits = String(value).replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  else if (digits.length === 11 && digits.startsWith("0")) digits = `91${digits.slice(1)}`;
  return digits;
};

const whatsappLink = (phone, message) => {
  const digits = whatsappPhone(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : "";
};

const phoneActions = (phone, message) => {
  const tel = cleanPhone(phone);
  const whatsapp = whatsappLink(phone, message);
  return `<div class="quick-actions">${tel ? `<a class="quick-action call-action" href="tel:${escapeHtml(tel)}" aria-label="Call ${escapeHtml(phone)}"><span>↗</span> Call</a>` : ""}${whatsapp ? `<a class="quick-action whatsapp-action" href="${escapeHtml(whatsapp)}" target="_blank" rel="noopener noreferrer" aria-label="Message on WhatsApp"><span>◉</span> WhatsApp</a>` : ""}</div>`;
};

const uuid = () => globalThis.crypto?.randomUUID?.() || `pt-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function parseDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || "").trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function dateIsValid(value) {
  return !value || Boolean(parseDate(value));
}

function dayNumber(date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

function formatToday() {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date());
}

function birthdayDaysAway(value) {
  const birthDate = parseDate(value);
  if (!birthDate) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  if (dayNumber(next) < dayNumber(today)) {
    next = new Date(now.getFullYear() + 1, birthDate.getMonth(), birthDate.getDate());
  }
  return dayNumber(next) - dayNumber(today);
}

function renewalDaysAway(value) {
  const renewal = parseDate(value);
  if (!renewal) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return dayNumber(renewal) - dayNumber(today);
}

function displayDate(value) {
  const parsed = parseDate(value);
  return parsed
    ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(parsed)
    : escapeHtml(value || "Date not set");
}

function dayLabel(days) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 0) return `${Math.abs(days)} day${days === -1 ? "" : "s"} overdue`;
  return `In ${days} days`;
}

function reminderStatus(item) {
  const days = Number(item?.days) || 0;
  if (days < 0) return { urgent: true, label: "OVERDUE" };
  if (days === 0) return { urgent: true, label: "TODAY" };
  if (days <= 7) return { urgent: true, label: "URGENT" };
  return { urgent: false, label: "UPCOMING" };
}

function reminderNotificationDetails(item) {
  const clientName = item?.client?.name || "Customer";
  if (item?.type === "renewal") {
    const policy = item.policy || {};
    return `${item.personName} (${clientName}) - ${policy.provider || "Policy"} ${policy.policyNumber || "N/A"} · ${dayLabel(item.days)}.`;
  }
  return `${item.personName}${item.relation ? ` (${item.relation})` : ""} for ${clientName} · ${dayLabel(item.days)}.`;
}

async function loadWorkspace() {
  const workspace = await db.loadWorkspace();
  Object.assign(state, workspace);
  updateNavigationCounts();
  render();
}

function updateNavigationCounts() {
  const reminders = getReminders();
  const outstanding = state.followUps.filter((item) => !item.isCompleted).length;
  document.querySelector("#customer-nav-count").textContent = state.clients.length;
  document.querySelector("#reminder-nav-count").textContent = reminders.length;
  document.querySelector("#followup-nav-count").textContent = outstanding;
  document.querySelector("#mobile-reminder-dot").classList.toggle("visible", reminders.length > 0);
}

function clientFor(id) {
  return state.clients.find((client) => client.id === id);
}

function clientPolicies(id) {
  return state.policies.filter((policy) => policy.clientId === id);
}

function clientMembers(id) {
  return state.familyMembers.filter((member) => member.clientId === id);
}

function clientFollowUps(id) {
  return state.followUps
    .filter((item) => item.clientId === id)
    .sort((a, b) => (parseDate(a.followUpDate)?.getTime() || 0) - (parseDate(b.followUpDate)?.getTime() || 0));
}

function allSearchText(client) {
  const family = clientMembers(client.id).map((member) => `${member.name} ${member.phone}`).join(" ");
  const policies = clientPolicies(client.id).map((policy) => policy.policyNumber).join(" ");
  return `${client.name} ${client.phone} ${client.agentName} ${family} ${policies}`.toLocaleLowerCase();
}

function getReminders() {
  const reminders = [];
  for (const client of state.clients) {
    const days = birthdayDaysAway(client.dob);
    if (days !== null && days <= 30) {
      reminders.push({
        type: "birthday",
        personName: client.name,
        client,
        phone: client.phone,
        dob: client.dob,
        days,
        title: "Birthday",
        detail: `A thoughtful wish for ${client.name}`
      });
    }
  }
  for (const member of state.familyMembers) {
    const client = clientFor(member.clientId);
    if (!client) continue;
    const days = birthdayDaysAway(member.dob);
    if (days !== null && days <= 30) {
      reminders.push({
        type: "birthday",
        personName: member.name,
        relation: member.relation,
        client,
        phone: member.phone || client.phone,
        dob: member.dob,
        days,
        title: "Family birthday",
        detail: `${member.relation} of ${client.name}`
      });
    }
  }
  for (const policy of state.policies) {
    const client = clientFor(policy.clientId);
    if (!client) continue;
    const days = renewalDaysAway(policy.renewalDate);
    if (days !== null && days <= 30) {
      reminders.push({
        type: "renewal",
        personName: client.name,
        client,
        policy,
        phone: client.phone,
        dob: policy.renewalDate,
        days,
        title: "Policy renewal",
        detail: `${policy.provider} · ${policy.policyNumber}`
      });
    }
  }
  return reminders.sort((a, b) => a.days - b.days || a.type.localeCompare(b.type));
}

function render() {
  document.querySelector("#today-label").textContent = formatToday();
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === state.page));
  updateNavigationCounts();
  if (state.detailClientId && clientFor(state.detailClientId)) {
    renderClientDetail(clientFor(state.detailClientId));
  } else if (state.page === "reminders") {
    renderReminders();
  } else if (state.page === "followups") {
    renderFollowUps();
  } else {
    renderCustomers();
  }
}

function statCard(icon, value, label, tone = "green") {
  return `<article class="stat-card"><span class="stat-icon ${tone}">${icon}</span><div class="stat-copy"><strong>${value}</strong><span>${label}</span></div></article>`;
}

function renderCustomers() {
  const agents = [...new Set(state.clients.map((client) => client.agentName.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const query = state.search.trim().toLocaleLowerCase();
  const filtered = state.clients
    .filter((client) => (state.agentFilter === "All" || client.agentName === state.agentFilter) && (!query || allSearchText(client).includes(query)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const policyCount = state.policies.length;
  const reminderCount = getReminders().length;
  const pending = state.followUps.filter((item) => !item.isCompleted).length;
  content.innerHTML = `
    <section class="welcome-row"><div><div class="eyebrow gold-eyebrow"><span class="eyebrow-line"></span>YOUR PRACTICE, IN GOOD ORDER</div><h1>Customers</h1><p class="page-subtitle">A little more organized. A lot more personal.</p></div><button class="button button-primary add-customer" data-action="add-client"><span class="plus">＋</span><span>Add customer</span></button></section>
    <section class="stats-grid" aria-label="Workspace overview">${statCard("♧", state.clients.length, "Total customers")}${statCard("▣", policyCount, "Active policies", "gold")}${statCard("◷", reminderCount, "Upcoming reminders", "soft-green")}${statCard("✓", pending, "Open follow-ups", "soft-gold")}</section>
    <section class="customer-section"><div class="section-heading"><div><h2>Your customers <span class="section-count">${filtered.length}</span></h2><p>Keep the details close. Keep the relationship closer.</p></div><div class="customer-tools"><label class="search-field"><svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg><input id="customer-search" type="search" placeholder="Search people, policies, phones…" value="${escapeHtml(state.search)}" autocomplete="off" aria-label="Search customers, family members, policies, or phone numbers" /><kbd>⌘ K</kbd></label><label class="filter-field"><span class="sr-only">Filter by agent</span><select id="agent-filter"><option value="All">All agents</option>${agents.map((agent) => `<option value="${escapeHtml(agent)}" ${state.agentFilter === agent ? "selected" : ""}>${escapeHtml(agent)}</option>`).join("")}</select><span class="select-chevron">⌄</span></label></div></div>
      ${filtered.length ? `<div class="customer-grid">${filtered.map(renderCustomerCard).join("")}</div>` : renderEmptyCustomers(state.clients.length > 0 || Boolean(query) || state.agentFilter !== "All")}
    </section>`;
  document.querySelector("#customer-search")?.addEventListener("input", (event) => {
    const position = event.target.selectionStart;
    state.search = event.target.value;
    const current = content.querySelector(".customer-grid, .customer-empty-state");
    if (current) current.outerHTML = filteredCustomerGrid();
    updateCustomerResultCount();
    const next = content.querySelector("#customer-search");
    if (next) { next.focus(); next.setSelectionRange(position, position); }
    document.querySelector("#customer-nav-count").textContent = state.clients.length;
  });
  document.querySelector("#agent-filter")?.addEventListener("change", (event) => {
    state.agentFilter = event.target.value;
    renderCustomers();
  });
}

function filteredCustomers() {
  const query = state.search.trim().toLocaleLowerCase();
  return state.clients
    .filter((client) => (state.agentFilter === "All" || client.agentName === state.agentFilter) && (!query || allSearchText(client).includes(query)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filteredCustomerGrid() {
  const clients = filteredCustomers();
  return clients.length
    ? `<div class="customer-grid">${clients.map(renderCustomerCard).join("")}</div>`
    : renderEmptyCustomers(state.clients.length > 0 || Boolean(state.search) || state.agentFilter !== "All");
}

function updateCustomerResultCount() {
  const title = content.querySelector(".customer-section .section-heading h2");
  const count = content.querySelector(".section-count");
  if (count) count.textContent = filteredCustomers().length;
  if (title) title.innerHTML = `Your customers <span class="section-count">${filteredCustomers().length}</span>`;
}

function renderEmptyCustomers(isFiltered) {
  return `<div class="empty-state customer-empty-state"><span class="empty-illustration">${isFiltered ? "⌕" : "♧"}</span><h3>${isFiltered ? "No matching customers" : "Your relationships start here"}</h3><p>${isFiltered ? "Try another name, phone, policy number, or agent." : "Add your first customer to keep their policies and important dates close at hand."}</p>${isFiltered ? `<button class="button button-quiet" data-action="clear-search">Clear search and filters</button>` : `<button class="button button-primary" data-action="add-client">＋ Add your first customer</button>`}</div>`;
}

function renderCustomerCard(client) {
  const policies = clientPolicies(client.id);
  const members = clientMembers(client.id);
  const birthdayDays = birthdayDaysAway(client.dob);
  const hasBirthdaySoon = birthdayDays !== null && birthdayDays <= 30;
  const initials = client.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return `<article class="customer-card"><div class="customer-card-top"><button class="customer-identity" data-action="open-client" data-id="${escapeHtml(client.id)}"><span class="customer-avatar avatar-${Math.abs([...client.name].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 5}">${escapeHtml(initials)}</span><span class="customer-name-group"><strong>${escapeHtml(client.name)}</strong><span>${escapeHtml(client.occupation || "Customer")}</span></span></button><button class="more-button" data-action="edit-client" data-id="${escapeHtml(client.id)}" aria-label="Edit ${escapeHtml(client.name)}" title="Edit customer">···</button></div><a class="customer-phone" href="tel:${escapeHtml(cleanPhone(client.phone))}"><span>↗</span>${escapeHtml(client.phone || "No phone number")}</a><div class="customer-card-meta"><span class="agent-tag"><span>✦</span>${escapeHtml(client.agentName || "No agent assigned")}</span>${hasBirthdaySoon ? `<span class="birthday-tag">✧ ${birthdayDays === 0 ? "Birthday today" : `Birthday in ${birthdayDays}d`}</span>` : ""}</div><div class="customer-card-footer"><span class="card-metric"><span class="metric-icon">▣</span>${policies.length} ${policies.length === 1 ? "policy" : "policies"}</span><span class="card-metric"><span class="metric-icon family-metric">♧</span>${members.length} ${members.length === 1 ? "member" : "members"}</span><button class="card-arrow" data-action="open-client" data-id="${escapeHtml(client.id)}" aria-label="View ${escapeHtml(client.name)}">↗</button></div><div class="customer-card-actions">${phoneActions(client.phone, `Hello ${client.name}, this is your insurance agent. How can I help you today?`)}</div></article>`;
}

function renderClientDetail(client) {
  const policies = clientPolicies(client.id);
  const members = clientMembers(client.id);
  const pending = clientFollowUps(client.id).filter((item) => !item.isCompleted).length;
  const initials = client.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const tabs = [
    { key: "family", title: "Family", count: members.length },
    { key: "policies", title: "Policies", count: policies.length },
    { key: "followups", title: "Follow-ups", count: pending }
  ];
  const tabContent = state.detailTab === "policies"
    ? renderPolicyTab(client)
    : state.detailTab === "followups"
      ? renderClientFollowUpTab(client)
      : renderFamilyTab(client);
  content.innerHTML = `<div class="detail-back-row"><button class="text-button" data-action="back-customers"><span>←</span> All customers</button><div class="detail-menu-actions"><button class="text-button edit-client-link" data-action="edit-client" data-id="${escapeHtml(client.id)}">Edit customer <span>↗</span></button><button class="text-button delete-client-link" data-action="delete-client" data-id="${escapeHtml(client.id)}">Delete customer <span>×</span></button></div></div><section class="detail-hero"><span class="detail-avatar">${escapeHtml(initials)}</span><div class="detail-identity"><div class="eyebrow gold-eyebrow"><span class="eyebrow-line"></span>CUSTOMER PROFILE</div><h1>${escapeHtml(client.name)}</h1><p>${escapeHtml(client.occupation || "Occupation not added")} <span class="detail-separator">·</span> ${escapeHtml(client.agentName || "No agent assigned")}</p></div><div class="detail-contact">${phoneActions(client.phone, commonClientMessage(client.name))}</div></section><section class="detail-summary">${statCard("▣", policies.length, "Policies")}${statCard("♧", members.length, "Family members", "gold")}${statCard("✓", pending, "Open follow-ups", "soft-green")}</section><section class="detail-section"><div class="detail-tabs" role="tablist">${tabs.map((tab) => `<button class="detail-tab ${state.detailTab === tab.key ? "active" : ""}" role="tab" aria-selected="${state.detailTab === tab.key}" data-action="detail-tab" data-tab="${tab.key}">${tab.title}<span>${tab.count}</span></button>`).join("")}</div>${tabContent}</section>`;
}

function renderFamilyTab(client) {
  const members = clientMembers(client.id).sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="tab-toolbar"><div><h2>Family members</h2><p>Remember the people who matter to them.</p></div><button class="button button-outline" data-action="add-family" data-client-id="${escapeHtml(client.id)}"><span class="plus">＋</span> Add member</button></div>${members.length ? `<div class="member-list">${members.map((member) => `<article class="member-row"><span class="member-avatar">${escapeHtml(member.name.trim().charAt(0).toUpperCase())}</span><div class="member-main"><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.relation)}${member.occupation ? ` · ${escapeHtml(member.occupation)}` : ""}</span></div><div class="member-dob"><small>DATE OF BIRTH</small><span>${displayDate(member.dob)}</span></div><div class="member-actions">${phoneActions(member.phone || client.phone, `Hello ${member.name}, warm birthday wishes from your insurance agent.`)}<button class="row-menu" data-action="edit-family" data-id="${escapeHtml(member.id)}" title="Edit family member" aria-label="Edit ${escapeHtml(member.name)}">✎</button><button class="row-menu delete-menu" data-action="delete-family" data-id="${escapeHtml(member.id)}" title="Delete family member" aria-label="Delete ${escapeHtml(member.name)}">×</button></div></article>`).join("")}</div>` : `<div class="empty-inline"><span>♧</span><div><strong>Family details make care more personal.</strong><p>Add a family member to keep their details and birthdays in one place.</p></div></div>`}`;
}

function renderPolicyTab(client) {
  const policies = clientPolicies(client.id).sort((a, b) => (parseDate(a.renewalDate)?.getTime() || 0) - (parseDate(b.renewalDate)?.getTime() || 0));
  return `<div class="tab-toolbar"><div><h2>Policies</h2><p>Cover, premium, and renewal date at a glance.</p></div><button class="button button-outline" data-action="add-policy" data-client-id="${escapeHtml(client.id)}"><span class="plus">＋</span> Add policy</button></div>${policies.length ? `<div class="policy-list">${policies.map((policy) => {
    const days = renewalDaysAway(policy.renewalDate);
    const urgent = days !== null && days <= 7;
    return `<article class="policy-card"><div class="policy-accent"></div><div class="policy-main"><div class="policy-provider-row"><span class="provider-icon">▣</span><div><strong>${escapeHtml(policy.provider)}</strong><span>Policy ${escapeHtml(policy.policyNumber)}</span></div></div><div class="policy-values"><div><small>SUM INSURED</small><strong>${money(policy.sumInsured)}</strong></div><div><small>ANNUAL PREMIUM</small><strong>${money(policy.premiumAmount)}</strong></div></div><div class="policy-renewal ${urgent ? "urgent" : ""}"><span class="renewal-icon">◷</span><span><small>RENEWAL DATE</small><strong>${displayDate(policy.renewalDate)}</strong></span><span class="renewal-badge ${urgent ? "urgent" : ""}">${days === null ? "Date not set" : dayLabel(days)}</span><button class="row-menu delete-menu" data-action="delete-policy" data-id="${escapeHtml(policy.id)}" title="Delete policy" aria-label="Delete policy ${escapeHtml(policy.policyNumber)}">×</button></div></div></article>`;
  }).join("")}</div>` : `<div class="empty-inline"><span>▣</span><div><strong>Protection, all in one place.</strong><p>Add this customer's policy details to keep cover and renewal dates close.</p></div></div>`}`;
}

function renderClientFollowUpTab(client) {
  const items = clientFollowUps(client.id);
  return `<div class="tab-toolbar"><div><h2>Follow-ups</h2><p>Small promises, kept on time.</p></div><button class="button button-outline" data-action="add-followup" data-client-id="${escapeHtml(client.id)}"><span class="plus">＋</span> Add follow-up</button></div>${items.length ? `<div class="followup-list">${items.map((item) => renderFollowUpRow(item, client, true)).join("")}</div>` : `<div class="empty-inline"><span>✓</span><div><strong>Make a note to reconnect.</strong><p>Add a follow-up and set a date to keep the conversation moving.</p></div></div>`}`;
}

function renderFollowUpRow(item, client, showDelete = false) {
  return `<article class="followup-row ${item.isCompleted ? "completed" : ""}"><label class="check-wrap"><input type="checkbox" data-action="toggle-followup" data-id="${escapeHtml(item.id)}" ${item.isCompleted ? "checked" : ""} aria-label="Mark follow-up ${item.isCompleted ? "incomplete" : "complete"}" /><span></span></label><div class="followup-note"><strong>${escapeHtml(item.note)}</strong><div class="followup-meta"><span>${escapeHtml(client?.name || "Unknown customer")}</span><span class="meta-dot">·</span><span>${escapeHtml(client?.agentName || "No agent assigned")}</span>${client?.phone ? `<a href="tel:${escapeHtml(cleanPhone(client.phone))}">${escapeHtml(client.phone)}</a>` : ""}</div></div><div class="followup-date"><small>${item.isCompleted ? "COMPLETED" : "FOLLOW-UP DATE"}</small><strong>${displayDate(item.followUpDate)}</strong></div>${showDelete ? `<button class="row-menu delete-menu" data-action="delete-followup" data-id="${escapeHtml(item.id)}" title="Delete follow-up" aria-label="Delete follow-up">×</button>` : ""}</article>`;
}

function renderReminders() {
  const reminders = getReminders();
  const urgent = reminders.filter((item) => item.days <= 7).length;
  const birthdays = reminders.filter((item) => item.type === "birthday").length;
  const renewals = reminders.filter((item) => item.type === "renewal").length;
  content.innerHTML = `<section class="welcome-row"><div><div class="eyebrow gold-eyebrow"><span class="eyebrow-line"></span>THE DATES THAT MATTER</div><h1>Reminders</h1><p class="page-subtitle">A thoughtful nudge, right when it matters.</p></div><button class="button button-outline" data-action="notify-reminders"><span class="notification-mini">♧</span> Enable reminders</button></section><section class="stats-grid reminders-stats">${statCard("◷", reminders.length, "Next 30 days")}${statCard("✧", birthdays, "Birthdays", "gold")}${statCard("▣", renewals, "Policy renewals", "soft-green")}${statCard("!", urgent, "Need attention", "soft-gold")}</section><section class="reminder-section"><div class="section-heading"><div><h2>Coming up <span class="section-count">${reminders.length}</span></h2><p>Birthdays and policy renewals across your customers.</p></div><div class="legend"><span><i class="legend-dot urgent-dot"></i>Within 7 days</span><span><i class="legend-dot"></i>Coming up</span></div></div>${reminders.length ? `<div class="reminder-list">${reminders.map(renderReminder).join("")}</div>` : `<div class="empty-state reminder-empty"><span class="empty-illustration">✧</span><h3>A little breathing room.</h3><p>No birthdays or policy renewals are due in the next 30 days.</p></div>`}</section>`;
}

function renderReminder(item) {
  const status = reminderStatus(item);
  const isRenewal = item.type === "renewal";
  const policy = item.policy || {};
  const client = item.client || {};
  const phoneName = item.relation ? item.personName : (client.name || "Customer");
  const renewalTiming = item.days < 0
    ? `was due on ${policy.renewalDate || "N/A"}`
    : item.days === 0
      ? `is due today (${policy.renewalDate || "N/A"})`
      : `is due on ${policy.renewalDate || "N/A"} (${dayLabel(item.days).toLowerCase()})`;
  const greeting = isRenewal
    ? `Hello ${client.name || "Customer"}, a friendly reminder that your ${policy.provider || "policy"} policy (${policy.policyNumber || "N/A"}) ${renewalTiming}. The premium is ${money(policy.premiumAmount)} and the sum insured is ${money(policy.sumInsured)}. Please let me know if I can help.`
    : `Hello ${phoneName}, warm birthday wishes! Wishing you a wonderful year ahead.`;
  const detail = isRenewal
    ? `<span class="reminder-detail"><span class="reminder-field-label">Provider</span> ${escapeHtml(policy.provider || "N/A")} <span class="detail-dot">·</span> <span class="reminder-field-label">Policy number</span> ${escapeHtml(policy.policyNumber || "N/A")}</span><div class="renewal-financials"><span><small>PREMIUM</small><strong>${money(policy.premiumAmount)}</strong></span><span><small>SUM INSURED</small><strong>${money(policy.sumInsured)}</strong></span></div>`
    : `<span class="reminder-detail">${item.relation ? `<span class="reminder-field-label">Relation</span> ${escapeHtml(item.relation)} <span class="detail-dot">·</span> ` : ""}<span class="reminder-field-label">Date of birth</span> ${displayDate(item.dob)}</span>`;
  const notificationTitle = isRenewal ? "Policy renewal reminder" : "Birthday reminder";
  const notificationMessage = reminderNotificationDetails(item);
  return `<article class="reminder-card ${status.urgent ? "is-urgent" : ""} ${isRenewal ? "renewal-card" : "birthday-card"}"><span class="reminder-icon ${isRenewal ? "renewal-reminder-icon" : "birthday-reminder-icon"}">${isRenewal ? "▣" : "✧"}</span><div class="reminder-main"><div class="reminder-title-row"><span class="reminder-kind">${item.title}</span><span class="status-badge ${status.urgent ? "urgent-pill" : "upcoming-pill"}">${status.label}</span></div><strong>${escapeHtml(item.personName)}${item.relation ? `<span class="reminder-relation"> · ${escapeHtml(item.relation)}</span>` : ""}</strong>${detail}<span class="reminder-client"><span class="reminder-field-label">Customer</span> ${escapeHtml(client.name || "Unknown")} <span class="detail-dot">·</span> <span class="reminder-field-label">Agent</span> ${escapeHtml(client.agentName || "No agent assigned")}</span></div><div class="reminder-date"><strong>${displayDate(item.dob)}</strong><span>${escapeHtml(dayLabel(item.days))}</span></div><div class="reminder-actions">${phoneActions(item.phone, greeting)}<button class="notify-item" data-action="notify-one" data-title="${escapeHtml(notificationTitle)}" data-message="${escapeHtml(notificationMessage)}" aria-label="Send notification for ${escapeHtml(item.personName)}" title="Send reminder notification">♧</button></div></article>`;
}

function renderFollowUps() {
  const items = [...state.followUps].sort((a, b) => {
    if (Boolean(a.isCompleted) !== Boolean(b.isCompleted)) return a.isCompleted ? 1 : -1;
    return (parseDate(a.followUpDate)?.getTime() || 0) - (parseDate(b.followUpDate)?.getTime() || 0);
  });
  const outstanding = items.filter((item) => !item.isCompleted).length;
  content.innerHTML = `<section class="welcome-row"><div><div class="eyebrow gold-eyebrow"><span class="eyebrow-line"></span>THE NEXT CONVERSATION</div><h1>Follow-ups</h1><p class="page-subtitle">Stay close to every promise you make.</p></div><span class="open-count-pill"><span class="status-dot"></span>${outstanding} open</span></section><section class="followups-overview"><div class="followups-callout"><span class="callout-icon">✓</span><div><strong>Good care lives in the follow-through.</strong><p>Every timely check-in helps your customers feel looked after.</p></div><span class="callout-count">${outstanding}<small>OPEN</small></span></div></section><section class="followups-section"><div class="section-heading"><div><h2>All follow-ups <span class="section-count">${items.length}</span></h2><p>Across all of your customers, in date order.</p></div></div>${items.length ? `<div class="followup-list global-followup-list">${items.map((item) => renderFollowUpRow(item, clientFor(item.clientId))).join("")}</div>` : `<div class="empty-state"><span class="empty-illustration">✓</span><h3>All caught up. Nicely done.</h3><p>Add a follow-up from a customer profile when it's time to check in.</p><button class="button button-quiet" data-action="go-customers">Go to customers <span>↗</span></button></div>`}</section>`;
}

const commonClientMessage = (name) => `Hello ${name}, this is your insurance agent. How can I help you today?`;
const field = (name, label, options = {}) => ({ name, label, ...options });

function openEntityForm(kind, record = {}, clientId = "") {
  const definitions = {
    client: {
      kicker: "CUSTOMER DETAILS",
      title: record.id ? "Edit customer" : "Add customer",
      submit: record.id ? "Save changes" : "Save customer",
      fields: [
        field("name", "Full name", { required: true, placeholder: "e.g. Ananya Sharma" }),
        field("phone", "Phone number", { required: true, type: "tel", placeholder: "+91 98765 43210" }),
        field("dob", "Date of birth", { placeholder: "DD/MM/YYYY", hint: "Use DD/MM/YYYY" }),
        field("occupation", "Occupation", { placeholder: "e.g. Architect" }),
        field("agentName", "Agent name", { required: true, placeholder: "e.g. Arjun Mehta" })
      ]
    },
    family: {
      kicker: "FAMILY DETAILS",
      title: record.id ? "Edit family member" : "Add family member",
      submit: record.id ? "Save changes" : "Save family member",
      fields: [
        field("name", "Full name", { required: true, placeholder: "e.g. Rohan Sharma" }),
        field("relation", "Relation", { type: "select", required: true, options: ["Spouse", "Child", "Parent"] }),
        field("phone", "Phone number", { type: "tel", placeholder: "+91 98765 43210" }),
        field("dob", "Date of birth", { placeholder: "DD/MM/YYYY", hint: "Use DD/MM/YYYY" }),
        field("occupation", "Occupation", { placeholder: "e.g. Student" })
      ]
    },
    policy: {
      kicker: "POLICY DETAILS",
      title: "Add policy",
      submit: "Save policy",
      fields: [
        field("policyNumber", "Policy number", { required: true, placeholder: "e.g. HL-2048-1932" }),
        field("provider", "Insurance provider", { required: true, placeholder: "e.g. HDFC Life" }),
        field("premiumAmount", "Annual premium", { required: true, type: "number", min: "0", step: "0.01", placeholder: "25000", prefix: "₹" }),
        field("sumInsured", "Sum insured", { required: true, type: "number", min: "0", step: "0.01", placeholder: "1000000", prefix: "₹" }),
        field("renewalDate", "Renewal date", { required: true, placeholder: "DD/MM/YYYY", hint: "Use DD/MM/YYYY" })
      ]
    },
    followup: {
      kicker: "FOLLOW-UP DETAILS",
      title: "Add follow-up",
      submit: "Save follow-up",
      fields: [
        field("note", "What would you like to follow up on?", { type: "textarea", required: true, placeholder: "e.g. Check in about the family health cover options", full: true }),
        field("followUpDate", "Follow-up date", { required: true, placeholder: "DD/MM/YYYY", hint: "Use DD/MM/YYYY" })
      ]
    }
  }[kind];
  if (!definitions) return;
  entityForm.dataset.kind = kind;
  entityForm.dataset.recordId = record.id || "";
  entityForm.dataset.clientId = record.clientId || clientId;
  document.querySelector("#modal-kicker").textContent = definitions.kicker;
  document.querySelector("#modal-title").textContent = definitions.title;
  document.querySelector("#submit-label").textContent = definitions.submit;
  document.querySelector("#modal-fields").innerHTML = definitions.fields.map((item) => {
    const id = `field-${item.name}`;
    const required = item.required ? "required" : "";
    const label = `<label for="${id}">${item.label}${item.required ? ' <span class="required-mark">*</span>' : ""}</label>`;
    const hint = item.hint ? `<small class="field-hint">${item.hint}</small>` : "";
    const value = escapeHtml(record[item.name] ?? "");
    let input;
    if (item.type === "select") {
      input = `<select id="${id}" name="${item.name}" ${required}>${item.options.map((option) => `<option value="${option}" ${record[item.name] === option ? "selected" : ""}>${option}</option>`).join("")}</select><span class="form-chevron">⌄</span>`;
    } else if (item.type === "textarea") {
      input = `<textarea id="${id}" name="${item.name}" rows="3" placeholder="${escapeHtml(item.placeholder || "")}" ${required}>${value}</textarea>`;
    } else {
      input = `${item.prefix ? `<span class="input-prefix">${item.prefix}</span>` : ""}<input id="${id}" name="${item.name}" type="${item.type || "text"}" value="${value}" placeholder="${escapeHtml(item.placeholder || "")}" ${item.type === "number" ? `min="${item.min}" step="${item.step}"` : ""} ${required} autocomplete="${item.type === "tel" ? "tel" : "off"}" />`;
    }
    return `<div class="form-field ${item.full ? "full-field" : ""} ${item.prefix ? "prefixed-field" : ""}">${label}<div class="input-wrap ${item.type === "select" ? "select-wrap" : ""}">${input}</div>${hint}</div>`;
  }).join("");
  formDialog.showModal();
  setTimeout(() => document.querySelector("#modal-fields input, #modal-fields textarea, #modal-fields select")?.focus(), 0);
}

function openConfirm(title, message, action) {
  document.querySelector("#confirm-title").textContent = title;
  document.querySelector("#confirm-message").textContent = message;
  pendingDelete = action;
  confirmDialog.showModal();
}

function showToast(message, kind = "success") {
  const region = document.querySelector("#toast-region");
  region.innerHTML = `<div class="toast toast-${kind}"><span>${kind === "error" ? "!" : "✓"}</span>${escapeHtml(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { region.innerHTML = ""; }, 3800);
}

async function notify(title, body) {
  if (!("Notification" in window)) {
    showToast("Notifications are not available in this browser.", "error");
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission === "granted") {
    const options = { body, icon: "./icon.svg", badge: "./icon.svg", tag: `policytrack-${title}-${body}` };
    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, options);
    } else {
      new Notification(title, options);
    }
    showToast("Notification sent.");
  } else {
    showToast("Notifications are turned off in your browser.", "error");
  }
}

function setPage(page) {
  state.page = page;
  state.detailClientId = null;
  state.search = page === "customers" ? state.search : "";
  render();
}

async function removeRecord(collection, id) {
  await db.remove(collection, id);
  await loadWorkspace();
  showToast("Deleted successfully.");
}

async function handleAction(action, element) {
  const id = element.dataset.id;
  const clientId = element.dataset.clientId;
  switch (action) {
    case "add-client": openEntityForm("client"); break;
    case "edit-client": { const client = clientFor(id); if (client) openEntityForm("client", client); break; }
    case "open-client": state.detailClientId = id; state.page = "customers"; state.detailTab = "family"; render(); break;
    case "back-customers": state.detailClientId = null; state.page = "customers"; render(); break;
    case "add-family": openEntityForm("family", {}, clientId); break;
    case "edit-family": { const member = state.familyMembers.find((item) => item.id === id); if (member) openEntityForm("family", member); break; }
    case "add-policy": openEntityForm("policy", {}, clientId); break;
    case "add-followup": openEntityForm("followup", {}, clientId); break;
    case "detail-tab": state.detailTab = element.dataset.tab; render(); break;
    case "delete-family": openConfirm("Remove this family member?", "Their details and birthday reminders will be removed from this customer.", () => removeRecord("familyMembers", id)); break;
    case "delete-policy": openConfirm("Delete this policy?", "This policy and its renewal reminder will be removed.", () => removeRecord("policies", id)); break;
    case "delete-followup": openConfirm("Delete this follow-up?", "This follow-up will be permanently removed.", () => removeRecord("followUps", id)); break;
    case "delete-client": openConfirm("Delete this customer?", "Their family members, policies, and follow-ups will also be removed.", async () => {
      await Promise.all(["familyMembers", "policies", "followUps"].map(async (collection) => Promise.all(state[collection].filter((record) => record.clientId === id).map((record) => db.remove(collection, record.id)))));
      await db.remove("clients", id);
      state.detailClientId = null;
      await loadWorkspace();
      showToast("Customer and related records deleted.");
    }); break;
    case "toggle-followup": {
      const item = state.followUps.find((followup) => followup.id === id);
      if (!item) return;
      await db.save("followUps", { ...item, isCompleted: element.checked });
      await loadWorkspace();
      break;
    }
    case "notify-one": await notify(element.dataset.title, element.dataset.message); break;
    case "notify-reminders": await notify("PolicyTrack reminders", `You have ${getReminders().length} birthday and policy reminders coming up.`); break;
    case "clear-search": state.search = ""; state.agentFilter = "All"; renderCustomers(); break;
    case "go-customers": setPage("customers"); break;
    default: break;
  }
}

content.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  if (action === "toggle-followup") return;
  event.preventDefault();
  try { await handleAction(action, actionTarget); }
  catch (error) { console.error("Unable to complete this action.", error); showToast(error.message || "Unable to complete this action. Try again.", "error"); }
});

content.addEventListener("change", async (event) => {
  const actionTarget = event.target.closest('[data-action="toggle-followup"]');
  if (!actionTarget) return;
  try { await handleAction("toggle-followup", actionTarget); }
  catch (error) { console.error("Unable to update this follow-up.", error); showToast(error.message || "Unable to update this follow-up. Try again.", "error"); }
});

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
document.querySelectorAll(".close-modal").forEach((button) => button.addEventListener("click", () => formDialog.close()));
document.querySelectorAll(".close-confirm").forEach((button) => button.addEventListener("click", () => confirmDialog.close()));
document.querySelector("#notify-button").addEventListener("click", () => notify("PolicyTrack notifications", "You'll receive helpful reminders from your workspace."));
document.querySelector("#confirm-delete").addEventListener("click", async () => {
  if (!pendingDelete) return;
  const action = pendingDelete;
  pendingDelete = null;
  confirmDialog.close();
  try { await action(); }
  catch (error) { console.error("Unable to delete this record.", error); showToast(error.message || "Unable to delete this record. Try again.", "error"); }
});

entityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(entityForm);
  const kind = entityForm.dataset.kind;
  const id = entityForm.dataset.recordId || uuid();
  const clientId = entityForm.dataset.clientId;
  let record;
  if (kind === "client") record = { id, name: data.get("name").trim(), phone: data.get("phone").trim(), dob: data.get("dob").trim(), occupation: data.get("occupation").trim(), agentName: data.get("agentName").trim() };
  if (kind === "family") record = { id, clientId, name: data.get("name").trim(), phone: data.get("phone").trim(), relation: data.get("relation"), dob: data.get("dob").trim(), occupation: data.get("occupation").trim() };
  if (kind === "policy") record = { id, clientId, policyNumber: data.get("policyNumber").trim(), provider: data.get("provider").trim(), premiumAmount: Number(data.get("premiumAmount")), sumInsured: Number(data.get("sumInsured")), renewalDate: data.get("renewalDate").trim() };
  if (kind === "followup") record = { id, clientId, note: data.get("note").trim(), followUpDate: data.get("followUpDate").trim(), isCompleted: false };
  const dateFields = kind === "client" || kind === "family" ? ["dob"] : kind === "policy" ? ["renewalDate"] : ["followUpDate"];
  for (const dateField of dateFields) {
    if (!dateIsValid(record[dateField])) {
      document.querySelector(`#field-${dateField}`).setCustomValidity("Enter a real date in DD/MM/YYYY format.");
      document.querySelector(`#field-${dateField}`).reportValidity();
      document.querySelector(`#field-${dateField}`).setCustomValidity("");
      return;
    }
  }
  try {
    await db.save(kind === "client" ? "clients" : kind === "family" ? "familyMembers" : kind === "policy" ? "policies" : "followUps", record);
    formDialog.close();
    await loadWorkspace();
    if (kind !== "client") { state.detailClientId = clientId; state.detailTab = kind === "family" ? "family" : kind === "policy" ? "policies" : "followups"; render(); }
    showToast(kind === "followup" ? "Follow-up saved. Sending a notification…" : `${kind === "client" ? "Customer" : kind === "family" ? "Family member" : "Policy"} saved.`);
    if (kind === "followup") await notify("New follow-up added", `A follow-up for ${clientFor(clientId)?.name || "your customer"} is scheduled for ${record.followUpDate}.`);
  } catch (error) {
    console.error("Unable to save this record.", error);
    showToast(error.message || "Unable to save this record. Try again.", "error");
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (state.page !== "customers" || state.detailClientId) setPage("customers");
    setTimeout(() => document.querySelector("#customer-search")?.focus(), 0);
  }
  if (event.key === "Escape" && !formDialog.open && confirmDialog.open) confirmDialog.close();
});

async function startApp() {
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    try { await navigator.serviceWorker.register("./sw.js"); }
    catch (error) { console.warn("The offline app could not be registered.", error); }
  }
  try { await loadWorkspace(); }
  catch (error) { console.error("Unable to load the workspace.", error); showToast(error.message || "Unable to load your workspace.", "error"); }
}

startApp();