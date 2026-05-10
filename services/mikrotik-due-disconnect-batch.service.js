const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const collections = require("../config/collections");
const {
  updatePPPoEUser,
  disconnectPPPoEUser,
  setIpoeLeaseStatic
} = require("./mikrotik");
const { writeAuditLog } = require("./audit-log.service");

const MANILA_TIMEZONE = "Asia/Manila";
const PPP_DISCONNECTED_PROFILE = "dc-putol";
const DEFAULT_DISCONNECTED_PLAN = "disconnection";
const DEFAULT_GRACE_DAYS = Number(process.env.DISCONNECT_AFTER_DAYS || 15);

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const getCollection = (name) => mongoose.connection.db.collection(name);

const defaultMikrotikDueDisconnectBatchConfig = () => ({
  Name: "Mikrotik Due Disconnect Batch",
  SendTime: "09:30",
  GraceDays:
    Number.isFinite(DEFAULT_GRACE_DAYS) && DEFAULT_GRACE_DAYS >= 0
      ? DEFAULT_GRACE_DAYS
      : 15,
  RecipientEmail: "",
  IsActive: false,
  DisconnectedPlanName: DEFAULT_DISCONNECTED_PLAN,
  LastRunKey: "",
  LastRunAt: null,
  LastRunSummary: "",
  LastError: ""
});

const sanitizeConfig = (config) => {
  const defaults = defaultMikrotikDueDisconnectBatchConfig();
  const graceDays = Number(config?.GraceDays ?? defaults.GraceDays);

  return {
    ...defaults,
    ...(config || {}),
    Name: String(config?.Name || defaults.Name).trim() || defaults.Name,
    SendTime: String(config?.SendTime || defaults.SendTime).trim() || defaults.SendTime,
    GraceDays: Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : defaults.GraceDays,
    RecipientEmail: String(config?.RecipientEmail || defaults.RecipientEmail).trim(),
    IsActive: Boolean(config?.IsActive),
    DisconnectedPlanName:
      String(config?.DisconnectedPlanName || defaults.DisconnectedPlanName).trim() ||
      defaults.DisconnectedPlanName,
    LastRunKey: String(config?.LastRunKey || "").trim(),
    LastRunAt: config?.LastRunAt || null,
    LastRunSummary: String(config?.LastRunSummary || "").trim(),
    LastError: String(config?.LastError || "").trim()
  };
};

const getConfigDocument = async () => {
  const collection = getCollection(collections.mikrotikDueDisconnectBatch);
  const current = await collection.findOne({});
  return sanitizeConfig(current || {});
};

const updateRunSummary = async (values = {}) => {
  const collection = getCollection(collections.mikrotikDueDisconnectBatch);
  const current = await collection.findOne({});
  const nextConfig = sanitizeConfig({
    ...(current || {}),
    ...values,
    updatedAt: new Date()
  });

  if (current?._id) {
    await collection.updateOne(
      { _id: current._id },
      {
        $set: {
          ...nextConfig,
          updatedAt: new Date()
        }
      }
    );
  } else {
    await collection.insertOne({
      ...nextConfig,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  return nextConfig;
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

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(values.year || 0),
    month: Number(values.month || 0),
    day: Number(values.day || 0),
    hour: Number(values.hour || 0),
    minute: Number(values.minute || 0)
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

const getManilaTodayStart = () => {
  const parts = getManilaDateParts(new Date());
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
};

const parseDateOnly = (value) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
};

const addDaysUtc = (date, days) => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const isDisconnectedClient = (client) => {
  const values = [client?.Status, client?.Profile, client?.NetPlan];

  return values.some((value) => {
    const normalized = normalizeText(value);
    return (
      normalized.includes("DISCONNECTION") ||
      normalized.includes("DISCONNECTED") ||
      normalized === normalizeText(PPP_DISCONNECTED_PROFILE)
    );
  });
};

const isUnpaidClient = (client) => {
  const paymentStatus = normalizeText(client?.PaymentStatus);
  const amountDue = Number(client?.AmountDue ?? 0);

  if (paymentStatus && paymentStatus !== "PAID") {
    return true;
  }

  return Number.isFinite(amountDue) && amountDue > 0;
};

const buildRow = ({
  clientId,
  result,
  authMode,
  accountName,
  clientName,
  dueDate,
  disconnectDate,
  amountDue,
  daysUntilDisconnect,
  daysOverdue,
  detail
}) => ({
  clientId: String(clientId || "").trim(),
  result,
  authMode: authMode || "-",
  accountName: accountName || "-",
  clientName: clientName || "-",
  dueDate: dueDate || "-",
  disconnectDate: disconnectDate || "-",
  amountDue: Number.isFinite(Number(amountDue)) ? Number(amountDue) : 0,
  daysUntilDisconnect:
    Number.isFinite(Number(daysUntilDisconnect)) ? Number(daysUntilDisconnect) : 0,
  daysOverdue: Number.isFinite(Number(daysOverdue)) ? Number(daysOverdue) : 0,
  detail: detail || ""
});

const applyMikrotikDisconnect = async (client, disconnectedPlanName) => {
  const authMode = normalizeText(client?.AuthenticationMode);
  const location = client?.ServerLocation;

  if (authMode === "PPPOE") {
    await updatePPPoEUser({
      oldUsername: client?.AccountName,
      username: client?.AccountName,
      password: client?.Password || "",
      profile: PPP_DISCONNECTED_PROFILE,
      location
    });
    await disconnectPPPoEUser(client?.AccountName, location);
    return {
      detail: "PPPOE profile changed to dc-putol and active session disconnected."
    };
  }

  if (authMode === "IPOE") {
    await setIpoeLeaseStatic({
      macAddress: client?.MacAddress || client?.macAddress || "",
      plan: "0M/0M",
      accountName: client?.AccountName || ""
    });
    return {
      detail: "IPOE lease comment changed to PLAN=0M/0M."
    };
  }

  return {
    detail: `Unsupported auth mode: ${client?.AuthenticationMode || "-"}`
  };
};

const generateMikrotikDueDisconnectBatchReport = async ({
  applyChanges = false,
  triggeredBy = "",
  selectedClientIds = []
} = {}) => {
  const config = await getConfigDocument();
  const disconnectedPlanName =
    String(config.DisconnectedPlanName || DEFAULT_DISCONNECTED_PLAN).trim() ||
    DEFAULT_DISCONNECTED_PLAN;
  const graceDays = Number(config.GraceDays || 15);
  const clientCollection = getCollection(collections.clients);
  const clients = await clientCollection.find({}).toArray();
  const todayStart = getManilaTodayStart();
  const rows = [];
  const updates = [];
  const selectedSet = new Set(
    Array.isArray(selectedClientIds)
      ? selectedClientIds.map((value) => String(value || "").trim()).filter(Boolean)
      : []
  );

  let checkedCount = 0;
  let eligibleForDisconnectionCount = 0;
  let overdueCount = 0;
  let updatedCount = 0;
  let skippedPaidCount = 0;

  for (const client of clients) {
    const authMode = normalizeText(client?.AuthenticationMode);

    if (authMode !== "PPPOE" && authMode !== "IPOE") {
      continue;
    }

    checkedCount += 1;

    const dueDateRaw = String(client?.DueDate || "").trim();
    const dueDate = parseDateOnly(dueDateRaw);

    if (!dueDate) {
      continue;
    }

    if (!isUnpaidClient(client)) {
      skippedPaidCount += 1;
      continue;
    }

    const disconnectDate = addDaysUtc(dueDate, graceDays);
    const daysUntilDisconnect = Math.round(
      (disconnectDate.getTime() - todayStart.getTime()) / (24 * 60 * 60 * 1000)
    );
    const daysOverdue = Math.max(0, Math.abs(Math.min(daysUntilDisconnect, 0)));

    if (disconnectDate > todayStart) {
      continue;
    }

    overdueCount += 1;

    if (isDisconnectedClient(client)) {
      continue;
    }

    const clientId = String(client?._id || "").trim();
    const isManualSelected = selectedSet.size > 0 && selectedSet.has(clientId);

    eligibleForDisconnectionCount += 1;

    let detail = `Overdue by ${graceDays} day(s) and still unpaid.`;

    if (applyChanges && (selectedSet.size === 0 || isManualSelected)) {
      const mikrotikResult = await applyMikrotikDisconnect(client, disconnectedPlanName);
      detail = `${detail} ${mikrotikResult.detail}`;

      const updatePayload = {
        Profile: disconnectedPlanName,
        NetPlan: disconnectedPlanName,
        Status: "DISCONNECTED",
        updatedAt: new Date()
      };

      await clientCollection.updateOne(
        { _id: client._id },
        {
          $set: updatePayload
        }
      );

      updatedCount += 1;
      updates.push({
        accountName: client?.AccountName || "",
        authMode,
        dueDate: dueDateRaw,
        amountDue: client?.AmountDue ?? 0
      });
    }

    rows.push(
      buildRow({
        clientId,
        result:
          applyChanges && selectedSet.size > 0 && !isManualSelected
            ? "SKIPPED_NOT_SELECTED"
            : applyChanges
              ? "DISCONNECTED_IN_MIKROTIK"
              : "READY_TO_DISCONNECT",
        authMode,
        accountName: client?.AccountName,
        clientName: client?.ClientName,
        dueDate: dueDateRaw,
        disconnectDate: disconnectDate.toISOString().slice(0, 10),
        amountDue: client?.AmountDue,
        daysUntilDisconnect,
        daysOverdue,
        detail:
          selectedSet.size > 0 && !isManualSelected && applyChanges
            ? `${detail} Skipped because this client was not selected.`
            : detail
      })
    );
  }

  const generatedAt = new Date();
  const summary = {
    checkedCount,
    eligibleForDisconnectionCount,
    overdueCount,
    updatedCount,
    skippedPaidCount,
    totalRows: rows.length
  };

  if (applyChanges) {
    const runSummary = `Checked ${checkedCount} client(s). Overdue unpaid: ${overdueCount}. Disconnected in MikroTik: ${updatedCount}.`;
    await updateRunSummary({
      LastRunKey: getManilaDateKey(generatedAt),
      LastRunAt: generatedAt,
      LastRunSummary: runSummary,
      LastError: ""
    });

    await writeAuditLog({
      actor: {
        name: triggeredBy || "Scheduler",
        username: triggeredBy || "scheduler",
        loginAccount: triggeredBy || "scheduler",
        type: triggeredBy ? "MANUAL" : "SCHEDULER"
      },
      module: "MIKROTIK_DUE_DISCONNECT_BATCH",
      action: triggeredBy ? "RUN_NOW" : "RUN_SCHEDULED",
      targetType: "MIKROTIK_DUE_DISCONNECT_BATCH",
      status: "SUCCESS",
      summary: runSummary,
      details: {
        summary,
        updates
      }
    });
  }

  return {
    generatedAt,
    applied: applyChanges,
    config,
    summary,
    rows
  };
};

let schedulerHandle = null;
let schedulerBusy = false;

const runScheduledMikrotikDueDisconnectBatch = async () => {
  if (schedulerBusy) {
    return;
  }

  schedulerBusy = true;

  try {
    const config = await getConfigDocument();

    if (!config.IsActive) {
      return;
    }

    const targetMinutes = getMinutesFromTimeKey(config.SendTime);

    if (targetMinutes === null) {
      return;
    }

    const now = new Date();
    const parts = getManilaDateParts(now);
    const currentMinutes = parts.hour * 60 + parts.minute;
    const todayKey = getManilaDateKey(now);

    if (currentMinutes < targetMinutes || config.LastRunKey === todayKey) {
      return;
    }

    await generateMikrotikDueDisconnectBatchReport({ applyChanges: true });
  } catch (err) {
    console.error("MIKROTIK DUE DISCONNECT BATCH SCHEDULER ERROR:", err.message);
    try {
      await updateRunSummary({
        LastRunSummary: "Scheduled overdue disconnect batch failed.",
        LastError: err.message
      });
    } catch (innerErr) {
      console.error("MIKROTIK DUE DISCONNECT SUMMARY ERROR:", innerErr.message);
    }
  } finally {
    schedulerBusy = false;
  }
};

const startMikrotikDueDisconnectBatchScheduler = () => {
  if (schedulerHandle) {
    return;
  }

  schedulerHandle = setInterval(runScheduledMikrotikDueDisconnectBatch, 60 * 1000);
  setTimeout(runScheduledMikrotikDueDisconnectBatch, 9000);
  console.log("MIKROTIK DUE DISCONNECT BATCH SCHEDULER STARTED");
};

module.exports = {
  defaultMikrotikDueDisconnectBatchConfig,
  sanitizeConfig,
  getConfigDocument,
  generateMikrotikDueDisconnectBatchReport,
  startMikrotikDueDisconnectBatchScheduler
};
