const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const collections = require("../config/collections");
const { getMikrotikCheckerSnapshot } = require("./mikrotik");
const { writeAuditLog } = require("./audit-log.service");

const MANILA_TIMEZONE = "Asia/Manila";

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const extractSpeedNumber = (value) => {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
};

const normalizeSpeedKey = (value) => {
  const speed = extractSpeedNumber(value);
  return speed ? `${speed}` : "";
};

const normalizePlanString = (value) =>
  normalizeText(value).replace(/\s+/g, "");

const extractIpoeCommentName = (comment) => {
  const match = String(comment || "").match(/NAME=([^;]+)/i);
  return normalizeText(match?.[1] || "");
};

const extractIpoeCommentPlan = (comment) => {
  const match = String(comment || "").match(/PLAN=([^;]+)/i);
  return String(match?.[1] || "").trim();
};

const isDisconnectedValue = (...values) =>
  values.some((value) => {
    const normalized = normalizeText(value);
    return (
      normalized.includes("DISCONNECTION") ||
      normalized.includes("DISCONNECTED") ||
      normalized === "DC-PUTOL" ||
      normalized === "0M/0M"
    );
  });

const getCollection = (name) => mongoose.connection.db.collection(name);

const defaultMikrotikCheckerConfig = () => ({
  Name: "Mikrotik Checker",
  SendTime: "08:30",
  RecipientEmail: "",
  IsActive: false,
  LastRunKey: "",
  LastRunAt: null,
  LastRunSummary: "",
  LastError: ""
});

const getGmailDefaults = async () => {
  try {
    const document = await getCollection(collections.gmail).findOne({});

    if (!document) {
      return {};
    }

    return {
      SmtpHost: String(document["SMTP HOST"] || "").trim(),
      SmtpPort: Number(document["SMTP PORT"] || 587),
      SmtpUser: String(document.Username || "").trim(),
      SmtpPassword: String(document.Password || ""),
      FromName: String(document.GMID || "").trim() || "DNS INTERNET",
      RecipientEmail: String(document.Username || "").trim()
    };
  } catch (_err) {
    return {};
  }
};

const sanitizeConfig = (config, defaults = {}) => {
  const resolvedDefaults = {
    ...defaultMikrotikCheckerConfig(),
    ...(defaults || {})
  };

  return {
    ...resolvedDefaults,
    ...(config || {}),
    SendTime: String(config?.SendTime ?? resolvedDefaults.SendTime).trim(),
    RecipientEmail: String(config?.RecipientEmail ?? resolvedDefaults.RecipientEmail).trim(),
    IsActive: Boolean(config?.IsActive),
    LastRunKey: String(config?.LastRunKey ?? resolvedDefaults.LastRunKey ?? "").trim(),
    LastRunAt: config?.LastRunAt || null,
    LastRunSummary: String(config?.LastRunSummary ?? resolvedDefaults.LastRunSummary ?? ""),
    LastError: String(config?.LastError ?? resolvedDefaults.LastError ?? ""),
    SmtpHost: String(config?.SmtpHost ?? resolvedDefaults.SmtpHost ?? "").trim(),
    SmtpPort: Number(config?.SmtpPort ?? resolvedDefaults.SmtpPort ?? 587),
    SmtpSecure: Boolean(config?.SmtpSecure ?? resolvedDefaults.SmtpSecure),
    SmtpUser: String(config?.SmtpUser ?? resolvedDefaults.SmtpUser ?? "").trim(),
    SmtpPassword: String(config?.SmtpPassword ?? resolvedDefaults.SmtpPassword ?? ""),
    FromName: String(config?.FromName ?? resolvedDefaults.FromName ?? "DNS INTERNET").trim()
  };
};

const buildNetPlanLookup = (rows) => {
  const map = new Map();

  for (const row of rows || []) {
    const names = [row?.Name, row?.name]
      .map((value) => normalizeText(value))
      .filter(Boolean);
    const speedValue = String(row?.Speed ?? row?.speed ?? "").trim();

    for (const name of names) {
      map.set(name, {
        name,
        speedValue
      });
    }
  }

  return map;
};

const resolveSystemPlan = ({ client, netPlanLookup }) => {
  const authMode = normalizeText(client?.AuthenticationMode);
  const rawValue =
    authMode === "PPPOE"
      ? String(client?.Profile || client?.NetPlan || "").trim()
      : String(client?.NetPlan || client?.Profile || "").trim();
  const planConfig = netPlanLookup.get(normalizeText(rawValue));
  const speedSource = planConfig?.speedValue || rawValue;

  return {
    raw: rawValue,
    normalized: normalizePlanString(rawValue),
    speedKey: normalizeSpeedKey(speedSource)
  };
};

const resolveMikrotikPlan = ({ rawValue }) => ({
  raw: String(rawValue || "").trim(),
  normalized: normalizePlanString(rawValue),
  speedKey: normalizeSpeedKey(rawValue)
});

const plansMatch = (systemPlan, mikrotikPlan) => {
  if (systemPlan.speedKey && mikrotikPlan.speedKey) {
    return systemPlan.speedKey === mikrotikPlan.speedKey;
  }

  return Boolean(systemPlan.normalized) && systemPlan.normalized === mikrotikPlan.normalized;
};

const createIssueRow = ({
  issueType,
  authMode,
  accountName,
  clientName,
  systemPlan,
  mikrotikPlan,
  systemMacAddress,
  mikrotikMacAddress,
  detail
}) => ({
  issueType,
  authMode,
  accountName: accountName || "-",
  clientName: clientName || "-",
  systemPlan: systemPlan || "-",
  mikrotikPlan: mikrotikPlan || "-",
  systemMacAddress: systemMacAddress || "-",
  mikrotikMacAddress: mikrotikMacAddress || "-",
  detail: detail || ""
});

const getManilaDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const valueByType = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(valueByType.year || 0),
    month: Number(valueByType.month || 0),
    day: Number(valueByType.day || 0),
    hour: String(valueByType.hour || "00"),
    minute: String(valueByType.minute || "00"),
    second: String(valueByType.second || "00")
  };
};

const getManilaDateKey = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

const getMinutesFromTimeKey = (value) => {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
};

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-PH", { timeZone: MANILA_TIMEZONE });
};

const createTransport = (config) => {
  const host = String(config.SmtpHost || "").trim();
  const port = Number(config.SmtpPort || 587);
  const normalizedHost = host.toLowerCase();
  const forceIpv4 =
    normalizedHost.includes("gmail.com") || normalizedHost.includes("googlemail.com");
  const isGmailHost = forceIpv4;
  const secure = isGmailHost ? port === 465 : Boolean(config.SmtpSecure);
  const requireTLS = isGmailHost ? port === 587 : !secure;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    family: forceIpv4 ? 4 : undefined,
    auth: {
      user: String(config.SmtpUser || "").trim(),
      pass: String(config.SmtpPassword || "")
    },
    tls: {
      servername: host
    },
    requireTLS
  });
};

const buildCsvAttachment = (rows = []) => {
  const header = [
    "Issue",
    "Auth",
    "Account Name",
    "Client Name",
    "System Plan",
    "MikroTik Plan",
    "System MAC",
    "MikroTik MAC",
    "Detail"
  ];

  const csvRows = [header]
    .concat(
      rows.map((row) => [
        row.issueType || "",
        row.authMode || "",
        row.accountName || "",
        row.clientName || "",
        row.systemPlan || "",
        row.mikrotikPlan || "",
        row.systemMacAddress || "",
        row.mikrotikMacAddress || "",
        row.detail || ""
      ])
    )
    .map((columns) =>
      columns
        .map((value) => `"${String(value || "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  return Buffer.from(csvRows, "utf8");
};

const getConfigDocument = async () => {
  const document = await getCollection(collections.mikrotikChecker).findOne({});
  const gmailDefaults = await getGmailDefaults();
  return sanitizeConfig(document, gmailDefaults);
};

const updateRunSummary = async (fields) => {
  await getCollection(collections.mikrotikChecker).updateOne(
    {},
    {
      $set: {
        ...fields,
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );
};

const generateMikrotikCheckerReport = async () => {
  const db = mongoose.connection.db;
  const [clients, netPlans, snapshot] = await Promise.all([
    db.collection(collections.clients).find({}).toArray(),
    db.collection(collections.netPlans).find({}).toArray(),
    getMikrotikCheckerSnapshot()
  ]);

  const netPlanLookup = buildNetPlanLookup(netPlans);
  const systemClients = (clients || []).filter((client) => {
    const authMode = normalizeText(client.AuthenticationMode);
    return (
      ["PPPOE", "IPOE"].includes(authMode) &&
      !isDisconnectedValue(client.Profile, client.NetPlan, client.Status)
    );
  });

  const systemAccountMap = new Map();
  const systemIpoeNameMap = new Map();

  for (const client of systemClients) {
    const accountKey = normalizeText(client.AccountName);
    if (accountKey) {
      systemAccountMap.set(accountKey, client);
    }
    if (normalizeText(client.AuthenticationMode) === "IPOE" && accountKey) {
      systemIpoeNameMap.set(accountKey, client);
    }
  }

  const pppSecrets = (snapshot?.pppSecrets || []).filter((row) => {
    const name = normalizeText(row?.name);
    const profile = normalizeText(row?.profile);
    return Boolean(name) && !isDisconnectedValue(profile);
  });

  const dhcpLeases = (snapshot?.dhcpLeases || []).filter((row) => {
    const accountName = extractIpoeCommentName(row?.comment);
    const plan = extractIpoeCommentPlan(row?.comment);
    return Boolean(accountName) && !isDisconnectedValue(plan);
  });

  const pppSecretMap = new Map(pppSecrets.map((row) => [normalizeText(row?.name), row]));
  const dhcpLeaseMap = new Map();

  for (const row of dhcpLeases) {
    const accountName = extractIpoeCommentName(row?.comment);
    if (accountName && !dhcpLeaseMap.has(accountName)) {
      dhcpLeaseMap.set(accountName, row);
    }
  }

  const issues = [];

  for (const client of systemClients) {
    const authMode = normalizeText(client.AuthenticationMode);
    const accountNameKey = normalizeText(client.AccountName);
    const systemPlan = resolveSystemPlan({ client, netPlanLookup });

    if (authMode === "PPPOE") {
      const mikrotikUser = pppSecretMap.get(accountNameKey);

      if (!mikrotikUser) {
        issues.push(
          createIssueRow({
            issueType: "NOT_FOUND_IN_MIKROTIK",
            authMode,
            accountName: client.AccountName,
            clientName: client.ClientName,
            systemPlan: systemPlan.raw,
            detail: "PPPOE user was not found in MikroTik."
          })
        );
        continue;
      }

      const mikrotikPlan = resolveMikrotikPlan({ rawValue: mikrotikUser.profile });

      if (!plansMatch(systemPlan, mikrotikPlan)) {
        issues.push(
          createIssueRow({
            issueType: "PLAN_NOT_BALANCE",
            authMode,
            accountName: client.AccountName,
            clientName: client.ClientName,
            systemPlan: systemPlan.raw,
            mikrotikPlan: mikrotikPlan.raw,
            detail: "PPPOE profile in MikroTik does not match the system plan."
          })
        );
      }

      continue;
    }

    const mikrotikLease = dhcpLeaseMap.get(accountNameKey);

    if (!mikrotikLease) {
      issues.push(
        createIssueRow({
          issueType: "NOT_FOUND_IN_MIKROTIK",
          authMode,
          accountName: client.AccountName,
          clientName: client.ClientName,
          systemPlan: systemPlan.raw,
          systemMacAddress: client.MacAddress || client.macAddress || "",
          detail: "IPOE lease comment/account was not found in MikroTik."
        })
      );
      continue;
    }

    const mikrotikPlan = resolveMikrotikPlan({
      rawValue: extractIpoeCommentPlan(mikrotikLease.comment)
    });

    if (!plansMatch(systemPlan, mikrotikPlan)) {
      issues.push(
        createIssueRow({
          issueType: "PLAN_NOT_BALANCE",
          authMode,
          accountName: client.AccountName,
          clientName: client.ClientName,
          systemPlan: systemPlan.raw,
          mikrotikPlan: mikrotikPlan.raw,
          systemMacAddress: client.MacAddress || client.macAddress || "",
          mikrotikMacAddress: mikrotikLease["mac-address"] || mikrotikLease.macAddress || "",
          detail: "IPOE MikroTik PLAN comment does not match the system plan."
        })
      );
    }
  }

  for (const pppUser of pppSecrets) {
    const accountNameKey = normalizeText(pppUser.name);
    if (!accountNameKey || systemAccountMap.has(accountNameKey)) {
      continue;
    }

    issues.push(
      createIssueRow({
        issueType: "NOT_FOUND_IN_SYSTEM",
        authMode: "PPPOE",
        accountName: pppUser.name,
        mikrotikPlan: pppUser.profile || "-",
        detail: "PPPOE user exists in MikroTik but not in the system."
      })
    );
  }

  for (const lease of dhcpLeases) {
    const accountNameKey = extractIpoeCommentName(lease.comment);
    if (!accountNameKey || systemIpoeNameMap.has(accountNameKey)) {
      continue;
    }

    issues.push(
      createIssueRow({
        issueType: "NOT_FOUND_IN_SYSTEM",
        authMode: "IPOE",
        accountName: accountNameKey,
        mikrotikPlan: extractIpoeCommentPlan(lease.comment) || "-",
        mikrotikMacAddress: lease["mac-address"] || lease.macAddress || "",
        detail: "IPOE lease exists in MikroTik but not in the system."
      })
    );
  }

  const summary = {
    totalSystemClientsChecked: systemClients.length,
    totalMikrotikPppUsers: pppSecrets.length,
    totalMikrotikIpoeLeases: dhcpLeases.length,
    totalIssues: issues.length,
    notBalanceCount: issues.filter((row) => row.issueType === "PLAN_NOT_BALANCE").length,
    notFoundInMikrotikCount: issues.filter((row) => row.issueType === "NOT_FOUND_IN_MIKROTIK").length,
    notFoundInSystemCount: issues.filter((row) => row.issueType === "NOT_FOUND_IN_SYSTEM").length,
    matchedCount: Math.max(
      systemClients.length - issues.filter((row) => row.issueType !== "NOT_FOUND_IN_SYSTEM").length,
      0
    )
  };

  return {
    generatedAt: new Date(),
    summary,
    rows: issues
  };
};

const validateConfigForSending = (config, { force = false } = {}) => {
  if (!force && !config.IsActive) {
    return "Mikrotik checker scheduler is inactive.";
  }
  if (!config.SmtpHost || !config.SmtpUser || !config.SmtpPassword) {
    return "SMTP host, user, and password are required.";
  }
  if (!config.RecipientEmail) {
    return "Recipient email is required.";
  }
  if (!config.SendTime) {
    return "Send time is required.";
  }
  return "";
};

const sendMikrotikCheckerEmail = async ({ force = false, triggeredBy = "" } = {}) => {
  const config = await getConfigDocument();
  const validationError = validateConfigForSending(config, { force });

  if (validationError) {
    return {
      sent: 0,
      skipped: 0,
      reason: validationError
    };
  }

  const now = new Date();
  const todayKey = getManilaDateKey(now);

  if (!force) {
    const currentParts = getManilaDateParts(now);
    const currentMinutes = Number(currentParts.hour) * 60 + Number(currentParts.minute);
    const scheduledMinutes = getMinutesFromTimeKey(config.SendTime);

    if (scheduledMinutes === null) {
      return { sent: 0, skipped: 0, reason: "Configured send time is invalid." };
    }

    if (currentMinutes < scheduledMinutes) {
      return { sent: 0, skipped: 0, reason: "Configured send time has not been reached yet." };
    }

    if (String(config.LastRunKey || "").trim() === todayKey) {
      return { sent: 0, skipped: 0, reason: "Mikrotik checker already ran today." };
    }
  }

  const report = await generateMikrotikCheckerReport();
  const transporter = createTransport(config);
  const fromAddress = String(config.SmtpUser || "").trim();
  const fromName = String(config.FromName || "DNS INTERNET").trim();
  const recipient = String(config.RecipientEmail || "").trim();
  const summary = report.summary || {};
  const subject = `DNS Mikrotik Checker Report - ${getManilaDateKey(now)}`;
  const lines = [
    "Hi DNS Team,",
    "",
    "Attached is the Mikrotik Checker report.",
    "",
    `Generated At: ${formatDateTime(report.generatedAt)}`,
    `System Clients Checked: ${summary.totalSystemClientsChecked || 0}`,
    `Matched: ${summary.matchedCount || 0}`,
    `Not Balance: ${summary.notBalanceCount || 0}`,
    `Not Found in MikroTik: ${summary.notFoundInMikrotikCount || 0}`,
    `Not Found in System: ${summary.notFoundInSystemCount || 0}`,
    "",
    triggeredBy ? `Triggered By: ${triggeredBy}` : "Triggered By: Scheduler",
    "",
    "Please see the attached CSV for the full detail."
  ];

  try {
    await transporter.sendMail({
      from: fromName ? `"${fromName}" <${fromAddress}>` : fromAddress,
      to: recipient,
      subject,
      text: lines.join("\n"),
      attachments: [
        {
          filename: `mikrotik-checker-${todayKey}.csv`,
          content: buildCsvAttachment(report.rows || []),
          contentType: "text/csv"
        }
      ]
    });

    const runSummary = `Mikrotik checker emailed to ${recipient}. Issues: ${summary.totalIssues || 0}${triggeredBy ? `, triggered by ${triggeredBy}` : ""}.`;
    await updateRunSummary({
      LastRunKey: todayKey,
      LastRunAt: new Date(),
      LastRunSummary: runSummary,
      LastError: ""
    });

    await writeAuditLog({
      actor: {
        name: triggeredBy || "Scheduler",
        username: triggeredBy || "scheduler",
        loginAccount: triggeredBy || "scheduler",
        type: force ? "MANUAL" : "SCHEDULER"
      },
      module: "MIKROTIK_CHECKER",
      action: force ? "RUN_EMAIL_NOW" : "RUN_EMAIL_SCHEDULED",
      targetType: "MIKROTIK_CHECKER",
      status: "SUCCESS",
      summary: runSummary,
      details: {
        recipient,
        reportSummary: summary
      }
    });

    return {
      sent: 1,
      skipped: 0,
      reason: runSummary,
      report
    };
  } catch (err) {
    await updateRunSummary({
      LastRunSummary: "Mikrotik checker email failed.",
      LastError: err.message
    });

    await writeAuditLog({
      actor: {
        name: triggeredBy || "Scheduler",
        username: triggeredBy || "scheduler",
        loginAccount: triggeredBy || "scheduler",
        type: force ? "MANUAL" : "SCHEDULER"
      },
      module: "MIKROTIK_CHECKER",
      action: force ? "RUN_EMAIL_NOW" : "RUN_EMAIL_SCHEDULED",
      targetType: "MIKROTIK_CHECKER",
      status: "FAILED",
      summary: "Mikrotik checker email failed.",
      details: {
        error: err.message,
        recipient
      }
    });

    return {
      sent: 0,
      skipped: 1,
      reason: err.message,
      report
    };
  }
};

let schedulerHandle = null;
let schedulerBusy = false;

const runScheduledMikrotikChecker = async () => {
  if (schedulerBusy) {
    return;
  }
  schedulerBusy = true;
  try {
    await sendMikrotikCheckerEmail();
  } catch (err) {
    console.error("MIKROTIK CHECKER SCHEDULER ERROR:", err.message);
    try {
      await updateRunSummary({
        LastRunSummary: "Scheduled Mikrotik checker failed.",
        LastError: err.message
      });
    } catch (innerErr) {
      console.error("MIKROTIK CHECKER SUMMARY ERROR:", innerErr.message);
    }
  } finally {
    schedulerBusy = false;
  }
};

const startMikrotikCheckerScheduler = () => {
  if (schedulerHandle) {
    return;
  }
  schedulerHandle = setInterval(runScheduledMikrotikChecker, 60 * 1000);
  setTimeout(runScheduledMikrotikChecker, 7000);
  console.log("MIKROTIK CHECKER SCHEDULER STARTED");
};

module.exports = {
  defaultMikrotikCheckerConfig,
  getConfigDocument,
  generateMikrotikCheckerReport,
  sanitizeConfig,
  sendMikrotikCheckerEmail,
  startMikrotikCheckerScheduler
};
