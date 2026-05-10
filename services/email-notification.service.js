const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const { jsPDF } = require("jspdf");
const autoTable = require("jspdf-autotable").default;
const collections = require("../config/collections");
const { writeAuditLog } = require("./audit-log.service");
const MANILA_TIMEZONE = "Asia/Manila";

const defaultEmailNotificationConfig = () => ({
  Name: "Billing SOA Notification",
  DaysOffset: 0,
  SendTime: "08:00",
  Subject: "DNS NETWORKS Billing Statement - @BillingMonth@",
  Body: [
    "Hi @ClientName@,",
    "",
    "Attached is your DNS NETWORKS billing statement.",
    "",
    "Account Number: @AccountNumber@",
    "Monthly Due: @MonthlyDue@",
    "Total Amount Due: @TotalAmountDue@",
    "Due Date: @DueDate@",
    "Subscription Covered: @SubscriptionCover@",
    "",
    "Thank you."
  ].join("\n"),
  SmtpHost: "",
  SmtpPort: 587,
  SmtpSecure: false,
  SmtpUser: "",
  SmtpPassword: "",
  FromName: "DNS NETWORKS",
  IsActive: false,
  ManualClientIds: [],
  LastRunKey: "",
  LastRunAt: null,
  LastRunSummary: "",
  LastError: ""
});

const getCollection = (name) => mongoose.connection.db.collection(name);

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
      FromName: String(document.GMID || "").trim() || "DNS NETWORKS"
    };
  } catch (_err) {
    return {};
  }
};

const sanitizeConfig = (config, defaults = defaultEmailNotificationConfig()) => {
  const resolvedDefaults = {
    ...defaultEmailNotificationConfig(),
    ...(defaults || {})
  };

  return {
    ...resolvedDefaults,
    ...(config || {}),
    DaysOffset: Number(config?.DaysOffset ?? resolvedDefaults.DaysOffset),
    SmtpPort: Number(config?.SmtpPort ?? resolvedDefaults.SmtpPort),
    SmtpSecure: Boolean(config?.SmtpSecure),
    IsActive: Boolean(config?.IsActive),
    ManualClientIds: Array.isArray(config?.ManualClientIds)
      ? config.ManualClientIds
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      : [],
    LastRunAt: config?.LastRunAt || null
  };
};

const formatCurrency = (value) =>
  `PHP ${Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

const formatDate = (value) => {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: MANILA_TIMEZONE
  });
};

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

const getManilaTimeKey = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  return `${parts.hour}:${parts.minute}`;
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

const toManilaDate = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
};

const addDays = (value, days) => {
  const next = new Date(value);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
};

const addOneMonthAnchored = (value, preferredDay) => {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const originalDay = Number(preferredDay) || date.getDate();
  const originalMonth = date.getMonth();
  const originalYear = date.getFullYear();
  const lastDayOfNextMonth = new Date(originalYear, originalMonth + 2, 0).getDate();
  const safeDay = Math.min(originalDay, lastDayOfNextMonth);

  return new Date(originalYear, originalMonth + 1, safeDay, 12, 0, 0, 0);
};

const getStatementRange = (client) => {
  if (!client?.DueDate) return { start: null, end: null };

  const start = new Date(client.DueDate);
  if (Number.isNaN(start.getTime())) return { start: null, end: null };

  const anchorDay = Number(client.SubscriptionCover) || start.getDate();
  const nextDue = addOneMonthAnchored(start, anchorDay);

  if (!nextDue) return { start, end: null };

  const end = new Date(nextDue);
  end.setDate(end.getDate() - 1);

  return { start, end };
};

const getLatestPaymentAmount = (payment) =>
  Number(payment?.TotalAmount || payment?.Cash || 0);

const buildBillingPdfBuffer = (client, history = []) => {
  const statementRange = getStatementRange(client);
  const statementMonth = statementRange.start
    ? statementRange.start.toLocaleDateString("en-PH", {
        month: "long",
        year: "numeric",
        timeZone: MANILA_TIMEZONE
      })
    : "Billing Statement";
  const latestPayment = history[0] || null;
  const previousBalance = Math.max(Number(client?.Balance || 0), 0);
  const monthlyDue = Number(client?.AmountDue || 0);
  const totalDue = monthlyDue + previousBalance;
  const statementCovered =
    statementRange.start && statementRange.end
      ? `${formatDate(statementRange.start)} to ${formatDate(statementRange.end)}`
      : "-";

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4"
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const statementTitle = `Billing Statement - ${statementMonth}`;

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 34, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("DNS NETWORKS", 18, 14);
  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.text(statementTitle, 18, 22);

  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Billed To", 18, 46);
  doc.text("Account Details", 112, 46);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(String(client?.ClientName || "-"), 18, 53);
  doc.text(String(client?.Address || "No address provided"), 18, 59);
  doc.text(`Contact: ${client?.ContactNumber || "N/A"}`, 18, 65);

  doc.text(`Account Number: ${client?.AccountNumber || "-"}`, 112, 53);
  doc.text(`Plan: ${formatCurrency(client?.AmountDue || 0)}`, 112, 59);
  doc.text(`Due Date: ${formatDate(client?.DueDate)}`, 112, 65);

  autoTable(doc, {
    startY: 80,
    head: [["Summary", "Value"]],
    body: [
      ["Monthly Due", formatCurrency(monthlyDue)],
      ["Previous Balance", formatCurrency(previousBalance)],
      ["Total Amount Due", formatCurrency(totalDue)],
      ["Subscription Covered", statementCovered]
    ],
    theme: "grid",
    styles: { fontSize: 10, cellPadding: 4, textColor: [15, 23, 42] },
    headStyles: { fillColor: [239, 246, 255], textColor: [15, 23, 42], fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 102 } }
  });

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    head: [["Description", "Amount"]],
    body: [
      ["Monthly internet service fee", formatCurrency(monthlyDue)],
      ["Previous balance carried forward", formatCurrency(previousBalance)],
      ["Total Amount Due", formatCurrency(totalDue)]
    ],
    theme: "grid",
    styles: { fontSize: 10, cellPadding: 4, textColor: [15, 23, 42] },
    headStyles: { fillColor: [219, 234, 254], textColor: [15, 23, 42], fontStyle: "bold" },
    bodyStyles: { lineColor: [219, 228, 238] },
    columnStyles: { 0: { cellWidth: 120 }, 1: { cellWidth: 52, halign: "right" } }
  });

  const latestPaymentY = doc.lastAutoTable.finalY + 10;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Latest Payment", 18, latestPaymentY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);

  const latestPaymentLines = latestPayment
    ? [
        `Date: ${formatDate(latestPayment.TransactionDate || latestPayment.PaymentDate)}`,
        `Receipt: ${latestPayment.PaymentReceipt || latestPayment.Invoice || "-"}`,
        `Amount: ${formatCurrency(getLatestPaymentAmount(latestPayment))}`
      ]
    : ["No payment history found for this account yet."];

  doc.text(latestPaymentLines, 18, latestPaymentY + 7);

  const paymentNotesY = latestPaymentY + 7 + latestPaymentLines.length * 6 + 10;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Payment Notes", 18, paymentNotesY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(
    [
      `Please settle your account on or before ${formatDate(client?.DueDate)}.`,
      "Payments posted after the due date may affect service continuity depending on account status.",
      "Keep this billing statement for your records."
    ],
    18,
    paymentNotesY + 7
  );

  const fileName = `${String(client?.AccountName || client?.ClientName || "billing")
    .replace(/[^\w-]+/g, "_")
    .replace(/^_+|_+$/g, "")}_${statementMonth.replace(/\s+/g, "_")}.pdf`;

  const arrayBuffer = doc.output("arraybuffer");
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName
  };
};

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const renderTemplate = (template, values) => {
  let output = String(template || "");

  Object.entries(values).forEach(([key, value]) => {
    output = output.replaceAll(`@${key}@`, String(value ?? ""));
  });

  return output;
};

const getBillingMonthLabel = (client) => {
  const statementRange = getStatementRange(client);

  return statementRange.start
    ? statementRange.start.toLocaleDateString("en-PH", {
        month: "long",
        year: "numeric",
        timeZone: MANILA_TIMEZONE
      })
    : "Billing Statement";
};

const buildTemplateValues = (client) => {
  const statementRange = getStatementRange(client);
  const previousBalance = Math.max(Number(client?.Balance || 0), 0);
  const monthlyDue = Number(client?.AmountDue || 0);
  const totalAmountDue = monthlyDue + previousBalance;
  const subscriptionCover =
    statementRange.start && statementRange.end
      ? `${formatDate(statementRange.start)} to ${formatDate(statementRange.end)}`
      : "-";

  return {
    ClientName: client?.ClientName || "",
    AccountName: client?.AccountName || "",
    AccountNumber: client?.AccountNumber || "",
    ContactNumber: client?.ContactNumber || "",
    MonthlyDue: formatCurrency(monthlyDue),
    TotalAmountDue: formatCurrency(totalAmountDue),
    DueDate: formatDate(client?.DueDate),
    SubscriptionCover: subscriptionCover,
    BillingMonth: getBillingMonthLabel(client)
  };
};

const getClientHistory = async (client) => {
  const accountNumber = String(client?.AccountNumber || "").trim();

  if (!accountNumber) {
    return [];
  }

  return getCollection(collections.print)
    .find({ AccountNumber: accountNumber })
    .sort({ createdAt: -1, TransactionDate: -1 })
    .limit(10)
    .toArray();
};

const getEmailReadyClients = async () => {
  const clients = await getCollection(collections.clients).find({}).toArray();

  return clients.filter((client) => {
    const hasValidEmail = isValidEmail(client?.Email);
    const emailBillingEnabled = Boolean(client?.EmailBillingEnabled);

    return hasValidEmail && emailBillingEnabled;
  });
};

const getEligibleClients = async (daysOffset) => {
  const clients = await getEmailReadyClients();
  const todayKey = getManilaDateKey();

  return clients.filter((client) => {
    const dueDate = client?.DueDate ? new Date(client.DueDate) : null;

    if (!dueDate || Number.isNaN(dueDate.getTime())) {
      return false;
    }

    const scheduledDate = addDays(dueDate, Number(daysOffset || 0));
    return getManilaDateKey(scheduledDate) === todayKey;
  });
};

const getManualClientsByIds = async (clientIds = []) => {
  const normalizedIds = [...new Set(
    (Array.isArray(clientIds) ? clientIds : [])
      .map((value) => String(value || "").trim())
      .filter((value) => mongoose.Types.ObjectId.isValid(value))
  )];

  if (normalizedIds.length === 0) {
    return [];
  }

  const clients = await getEmailReadyClients();
  const idSet = new Set(normalizedIds);

  return clients.filter((client) => idSet.has(String(client?._id || "")));
};

const createTransport = (config) => {
  const host = String(config.SmtpHost || "").trim();
  const port = Number(config.SmtpPort || 587);
  const normalizedHost = host.toLowerCase();
  const forceIpv4 =
    normalizedHost.includes("gmail.com") || normalizedHost.includes("googlemail.com");
  const isGmailHost = forceIpv4;
  const secure = isGmailHost
    ? port === 465
    : Boolean(config.SmtpSecure);
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

const validateConfigForSending = (config) => {
  if (!config.IsActive) {
    return "Email notification is inactive.";
  }

  if (!config.SmtpHost || !config.SmtpUser || !config.SmtpPassword) {
    return "SMTP host, user, and password are required.";
  }

  if (!config.SendTime) {
    return "Send time is required.";
  }

  return "";
};

const getConfigDocument = async () => {
  const document = await getCollection(collections.emailNotification).findOne({});
  const gmailDefaults = await getGmailDefaults();
  return sanitizeConfig(document, {
    ...defaultEmailNotificationConfig(),
    ...gmailDefaults
  });
};

const updateRunSummary = async (fields) => {
  await getCollection(collections.emailNotification).updateOne(
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

let schedulerHandle = null;
let schedulerBusy = false;

const sendBillingEmails = async ({ force = false, triggeredBy = "", manualClientIds = [] } = {}) => {
  const config = await getConfigDocument();
  const validationError = validateConfigForSending(config);

  if (validationError) {
    return {
      sent: 0,
      skipped: 0,
      reason: validationError
    };
  }

  const now = new Date();
  const todayKey = getManilaDateKey(now);
  const currentTimeKey = getManilaTimeKey(now);

  if (!force) {
    const currentMinutes = getMinutesFromTimeKey(currentTimeKey);
    const scheduledMinutes = getMinutesFromTimeKey(config.SendTime);

    if (scheduledMinutes === null) {
      return {
        sent: 0,
        skipped: 0,
        reason: "Configured send time is invalid."
      };
    }

    if (currentMinutes === null || currentMinutes < scheduledMinutes) {
      return {
        sent: 0,
        skipped: 0,
        reason: "Configured send time has not been reached yet."
      };
    }

    if (String(config.LastRunKey || "").trim() === todayKey) {
      return {
        sent: 0,
        skipped: 0,
        reason: "Email notification already ran today."
      };
    }
  }

  const eligibleClients = await getEligibleClients(config.DaysOffset);
  const selectedManualClients = force
    ? await getManualClientsByIds(
        Array.isArray(manualClientIds) && manualClientIds.length > 0
          ? manualClientIds
          : config.ManualClientIds
      )
    : [];
  const clientMap = new Map();

  [...eligibleClients, ...selectedManualClients].forEach((client) => {
    const key = String(client?._id || client?.AccountNumber || client?.AccountName || "");

    if (key) {
      clientMap.set(key, client);
    }
  });

  const clients = Array.from(clientMap.values());

  if (clients.length === 0) {
    if (!force) {
      await updateRunSummary({
        LastRunKey: todayKey,
        LastRunAt: new Date(),
        LastRunSummary: "No eligible email-billing clients found for this run.",
        LastError: ""
      });
    }

    return {
      sent: 0,
      skipped: 0,
      reason: force
        ? "No eligible or manually selected clients found."
        : "No eligible clients found."
    };
  }

  const transporter = createTransport(config);
  const fromAddress = String(config.SmtpUser || "").trim();
  const fromName = String(config.FromName || "DNS NETWORKS").trim();
  let sent = 0;
  let skipped = 0;
  const errors = [];

  for (const client of clients) {
    try {
      const history = await getClientHistory(client);
      const { buffer, fileName } = buildBillingPdfBuffer(client, history);
      const values = buildTemplateValues(client);
      const subject = renderTemplate(config.Subject, values);
      const body = renderTemplate(config.Body, values);

      await transporter.sendMail({
        from: fromName ? `"${fromName}" <${fromAddress}>` : fromAddress,
        to: String(client.Email || "").trim(),
        subject,
        text: body,
        attachments: [
          {
            filename: fileName,
            content: buffer,
            contentType: "application/pdf"
          }
        ]
      });

      sent += 1;
    } catch (err) {
      skipped += 1;
      errors.push(`${client?.AccountName || client?.ClientName || "Client"}: ${err.message}`);
    }
  }

  const summary = `Sent ${sent} email(s), skipped ${skipped} email(s)${triggeredBy ? `, triggered by ${triggeredBy}` : ""}.`;

  await updateRunSummary({
    LastRunKey: todayKey,
    LastRunAt: new Date(),
    LastRunSummary: summary,
    LastError: errors.join(" | ")
  });

  await writeAuditLog({
    actor: {
      name: triggeredBy || "Scheduler",
      username: triggeredBy || "scheduler",
      loginAccount: triggeredBy || "scheduler",
      type: force ? "MANUAL" : "SCHEDULER"
    },
    module: "EMAIL",
    action: force ? "RUN_NOTIFICATION_NOW" : "RUN_NOTIFICATION_SCHEDULED",
    targetType: "EMAIL_NOTIFICATION",
    status: skipped > 0 && sent === 0 ? "FAILED" : "SUCCESS",
    summary,
    details: {
      errors,
      clientCount: clients.length
    },
    values: clients.map((client) => ({
      accountName: client?.AccountName || "",
      clientName: client?.ClientName || "",
      email: client?.Email || ""
    }))
  });

  return {
    sent,
    skipped,
    reason: summary,
    errors
  };
};

const runScheduledEmailNotifications = async () => {
  if (schedulerBusy) {
    return;
  }

  schedulerBusy = true;

  try {
    await sendBillingEmails();
  } catch (err) {
    console.error("EMAIL NOTIFICATION SCHEDULER ERROR:", err.message);

    try {
      await updateRunSummary({
        LastError: err.message,
        LastRunSummary: "Scheduled email notification failed."
      });
    } catch (innerErr) {
      console.error("EMAIL NOTIFICATION SUMMARY ERROR:", innerErr.message);
    }
  } finally {
    schedulerBusy = false;
  }
};

const startEmailNotificationScheduler = () => {
  if (schedulerHandle) {
    return;
  }

  schedulerHandle = setInterval(runScheduledEmailNotifications, 60 * 1000);
  setTimeout(runScheduledEmailNotifications, 5000);
  console.log("EMAIL NOTIFICATION SCHEDULER STARTED");
};

module.exports = {
  buildBillingPdfBuffer,
  defaultEmailNotificationConfig,
  getEmailReadyClients,
  getGmailDefaults,
  getConfigDocument,
  getEligibleClients,
  getManualClientsByIds,
  sanitizeConfig,
  sendBillingEmails,
  startEmailNotificationScheduler
};
