const mongoose = require("mongoose");
const collections = require("../config/collections");
const {
  setPPPoESecretDisconnected,
  setIpoeLeaseStatic
} = require("./mikrotik");
const { writeAuditLog } = require("./audit-log.service");

const MANILA_TIMEZONE = "Asia/Manila";
const PPP_DISCONNECTED_PROFILE = "dc-putol";
const DEFAULT_DISCONNECTED_PLAN = "disconnection";
const DEFAULT_GRACE_DAYS = Number(process.env.DISCONNECT_AFTER_DAYS || 15);
const OVERDUE_ACCUMULATE_THRESHOLD = 15;

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const getCollection = (name) => mongoose.connection.db.collection(name);

const defaultMikrotikDcBatchConfig = () => ({
  Name: "Mikrotik DC Batch",
  SendTime: "09:00",
  GraceDays:
    Number.isFinite(DEFAULT_GRACE_DAYS) && DEFAULT_GRACE_DAYS >= 0
      ? DEFAULT_GRACE_DAYS
      : 15,
  IsActive: false,
  DisconnectedPlanName: DEFAULT_DISCONNECTED_PLAN,
  LastRunKey: "",
  LastRunAt: null,
  LastRunSummary: "",
  LastError: ""
});

const sanitizeConfig = (config) => {
  const defaults = defaultMikrotikDcBatchConfig();
  const graceDays = Number(config?.GraceDays ?? defaults.GraceDays);

  return {
    ...defaults,
    ...(config || {}),
    Name: String(config?.Name || defaults.Name).trim() || defaults.Name,
    SendTime: String(config?.SendTime || defaults.SendTime).trim() || defaults.SendTime,
    GraceDays: Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : defaults.GraceDays,
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
  const collection = getCollection(collections.mikrotikDcBatch);
  const current = await collection.findOne({});
  return sanitizeConfig(current || {});
};

const updateRunSummary = async (values = {}) => {
  const collection = getCollection(collections.mikrotikDcBatch);
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

const isSystemDisconnected = (client) => {
  const values = [
    client?.Status,
    client?.Profile,
    client?.NetPlan
  ];

  return values.some((value) => {
    const normalized = normalizeText(value);
    return (
      normalized.includes("DISCONNECTION") ||
      normalized.includes("DISCONNECTED") ||
      normalized === PPP_DISCONNECTED_PROFILE ||
      normalized === "0M/0M"
    );
  });
};

const buildRow = ({
  result,
  authMode,
  accountName,
  clientName,
  oldProfile,
  oldNetPlan,
  nextPlan,
  detail
}) => ({
  result,
  authMode: authMode || "-",
  accountName: accountName || "-",
  clientName: clientName || "-",
  oldProfile: oldProfile || "-",
  oldNetPlan: oldNetPlan || "-",
  nextPlan: nextPlan || "-",
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
    minute: Number(values.minute || 0),
    second: Number(values.second || 0)
  };
};

const getManilaDateKey = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

const formatDateOnlyUtc = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "-";
  }

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
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

const isUnpaidClient = (client) => {
  const paymentStatus = normalizeText(client?.PaymentStatus);
  const amountDue = Number(client?.AmountDue ?? 0);

  if (paymentStatus && paymentStatus !== "PAID") {
    return true;
  }

  return Number.isFinite(amountDue) && amountDue > 0;
};

const formatDisconnectRemark = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  const dateKey = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const timeKey = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
  return `Disconnected by DC Batch on ${dateKey} ${timeKey}`;
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

const isBypassClient = (client, bypassAccountKeys, bypassClientIds) => {
  const accountKey = normalizeText(client?.AccountName);
  const clientId = String(client?._id || "").trim();
  return (accountKey && bypassAccountKeys.has(accountKey)) || (clientId && bypassClientIds.has(clientId));
};

const getPlanPrice = (plan) => Number(plan?.Price ?? plan?.price ?? 0);
const getPlanName = (plan) => String(plan?.Name ?? plan?.name ?? "").trim();
const getPlanSpeed = (plan) => String(plan?.Speed ?? plan?.speed ?? "").trim();

const resolveDisconnectedAmountDue = (netPlans, planValue, fallbackAmount) => {
  const normalizedPlanValue = String(planValue || "").trim().toUpperCase();

  if (!normalizedPlanValue) {
    return fallbackAmount;
  }

  const matchedPlan = (netPlans || []).find((plan) => {
    const planName = getPlanName(plan).toUpperCase();
    const planSpeed = getPlanSpeed(plan).toUpperCase();
    return planName === normalizedPlanValue || planSpeed === normalizedPlanValue;
  });

  if (!matchedPlan) {
    return fallbackAmount;
  }

  const amount = getPlanPrice(matchedPlan);
  return Number.isFinite(amount) ? amount : fallbackAmount;
};

const generateMikrotikDcBatchReport = async ({
  applyChanges = false,
  triggeredBy = "",
  configOverrides = {}
} = {}) => {
  const storedConfig = await getConfigDocument();
  const config = sanitizeConfig({
    ...storedConfig,
    ...(configOverrides || {})
  });
  const disconnectedPlanName =
    String(config.DisconnectedPlanName || DEFAULT_DISCONNECTED_PLAN).trim() ||
    DEFAULT_DISCONNECTED_PLAN;
  const graceDays =
    Number.isFinite(Number(config.GraceDays)) && Number(config.GraceDays) >= 0
      ? Number(config.GraceDays)
      : Number.isFinite(DEFAULT_GRACE_DAYS) && DEFAULT_GRACE_DAYS >= 0
        ? DEFAULT_GRACE_DAYS
        : 15;
  const clientCollection = getCollection(collections.clients);
  const [clients, bypassRows, netPlans] = await Promise.all([
    clientCollection.find({}).toArray(),
    getCollection(collections.clientBypass).find({}).toArray(),
    getCollection(collections.netPlans).find({}).toArray()
  ]);
  const bypassAccountKeys = new Set(
    (bypassRows || [])
      .map((row) => normalizeText(row?.AccountNameKey || row?.AccountName))
      .filter(Boolean)
  );
  const bypassClientIds = new Set(
    (bypassRows || [])
      .map((row) => String(row?.ClientId || "").trim())
      .filter(Boolean)
  );
  const rows = [];
  const updates = [];
  const todayStart = getManilaTodayStart();

  let checkedCount = 0;
  let disconnectedFoundCount = 0;
  let updatedCount = 0;
  let alreadyDisconnectedCount = 0;
  let bypassSkippedCount = 0;

  for (const client of clients) {
    const authMode = normalizeText(client?.AuthenticationMode);

    if (authMode !== "PPPOE" && authMode !== "IPOE") {
      continue;
    }

    checkedCount += 1;

    if (isBypassClient(client, bypassAccountKeys, bypassClientIds)) {
      bypassSkippedCount += 1;
      continue;
    }

    const accountKey = normalizeText(client?.AccountName);
    const oldProfile = String(client?.Profile || "").trim();
    const oldNetPlan = String(client?.NetPlan || "").trim();
    const nextPlanValue = authMode === "PPPOE" ? PPP_DISCONNECTED_PROFILE : disconnectedPlanName;
    const dueDateRaw = String(client?.DueDate || "").trim();
    const dueDate = parseDateOnly(dueDateRaw);

    if (!dueDate) {
      continue;
    }

    if (!isUnpaidClient(client)) {
      continue;
    }

    const disconnectDate = addDaysUtc(dueDate, graceDays);
    const isEligible =
      graceDays < OVERDUE_ACCUMULATE_THRESHOLD
        ? disconnectDate.getTime() === todayStart.getTime()
        : disconnectDate.getTime() <= todayStart.getTime();

    if (!isEligible) {
      continue;
    }

    disconnectedFoundCount += 1;
    const overdueDays = Math.max(
      0,
      Math.round((todayStart.getTime() - disconnectDate.getTime()) / (24 * 60 * 60 * 1000))
    );

    if (isSystemDisconnected(client)) {
      alreadyDisconnectedCount += 1;
      continue;
    }

    const disconnectedAmountDue = resolveDisconnectedAmountDue(
      netPlans,
      authMode === "PPPOE" ? PPP_DISCONNECTED_PROFILE : disconnectedPlanName,
      Number(client?.AmountDue ?? 0)
    );
    const updatePayload = {
      PreviousAuthenticationMode: client?.AuthenticationMode || "",
      PreviousProfile: oldProfile,
      PreviousNetPlan: oldNetPlan,
      PreviousMacAddress: client?.MacAddress || "",
      Profile: authMode === "PPPOE" ? PPP_DISCONNECTED_PROFILE : disconnectedPlanName,
      NetPlan: disconnectedPlanName,
      AmountDue: disconnectedAmountDue,
      Status: "DISCONNECTED",
      updatedAt: new Date()
    };
    let detail = `Due date ${formatDateOnlyUtc(dueDate)} exceeded the ${graceDays}-day grace period. Disconnect date ${formatDateOnlyUtc(disconnectDate)}.`;

    rows.push(
      buildRow({
        result: applyChanges ? "UPDATED_TO_DISCONNECTED" : "READY_TO_UPDATE",
        authMode,
        accountName: client?.AccountName,
        clientName: client?.ClientName,
        oldProfile,
        oldNetPlan,
        nextPlan: nextPlanValue,
        detail: `${detail} ${overdueDays > 0 ? `Overdue by ${overdueDays} day(s) past disconnect date.` : "Ready for disconnect today."}`
      })
    );

    if (applyChanges && client?._id) {
      if (authMode === "PPPOE") {
        const disconnectRemark = formatDisconnectRemark(new Date());
        await setPPPoESecretDisconnected({
          username: client?.AccountName,
          password: client?.Password || "",
          profile: PPP_DISCONNECTED_PROFILE,
          disconnectRemark
        });
        detail = `${detail} PPPoE secret changed to ${PPP_DISCONNECTED_PROFILE} with remark "${disconnectRemark}".`;
      } else if (authMode === "IPOE") {
        await setIpoeLeaseStatic({
          macAddress: client?.MacAddress || client?.macAddress || "",
          plan: "0M/0M",
          accountName: client?.AccountName || ""
        });
        detail = `${detail} IPOE lease comment changed to PLAN=0M/0M.`;
      }

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
        oldProfile,
        oldNetPlan,
        nextPlan: nextPlanValue
      });

      rows[rows.length - 1].detail = detail;
      rows[rows.length - 1].result = "UPDATED_TO_DISCONNECTED";
    }
  }

  const generatedAt = new Date();
  const summary = {
    checkedCount,
    disconnectedFoundCount,
    updatedCount,
    alreadyDisconnectedCount,
    bypassSkippedCount,
    totalRows: rows.length
  };

  if (applyChanges) {
    const runSummary = `Checked ${checkedCount} client(s). Eligible after ${graceDays} day(s): ${disconnectedFoundCount}. Updated in system: ${updatedCount}. Skipped bypass: ${bypassSkippedCount}.`;
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
      module: "MIKROTIK_DC_BATCH",
      action: triggeredBy ? "RUN_NOW" : "RUN_SCHEDULED",
      targetType: "MIKROTIK_DC_BATCH",
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

const runScheduledMikrotikDcBatch = async () => {
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

    await generateMikrotikDcBatchReport({ applyChanges: true });
  } catch (err) {
    console.error("MIKROTIK DC BATCH SCHEDULER ERROR:", err.message);
    try {
      await updateRunSummary({
        LastRunSummary: "Scheduled MikroTik DC batch failed.",
        LastError: err.message
      });
    } catch (innerErr) {
      console.error("MIKROTIK DC BATCH SUMMARY ERROR:", innerErr.message);
    }
  } finally {
    schedulerBusy = false;
  }
};

const startMikrotikDcBatchScheduler = () => {
  if (schedulerHandle) {
    return;
  }

  schedulerHandle = setInterval(runScheduledMikrotikDcBatch, 60 * 1000);
  setTimeout(runScheduledMikrotikDcBatch, 8000);
  console.log("MIKROTIK DC BATCH SCHEDULER STARTED");
};

module.exports = {
  defaultMikrotikDcBatchConfig,
  sanitizeConfig,
  getConfigDocument,
  updateRunSummary,
  generateMikrotikDcBatchReport,
  startMikrotikDcBatchScheduler
};


