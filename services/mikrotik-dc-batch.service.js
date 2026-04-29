const mongoose = require("mongoose");
const collections = require("../config/collections");
const { getMikrotikCheckerSnapshot } = require("./mikrotik");
const { writeAuditLog } = require("./audit-log.service");

const MANILA_TIMEZONE = "Asia/Manila";
const PPP_DISCONNECTED_PROFILE = "DC-PUTOL";
const DEFAULT_DISCONNECTED_PLAN = "disconnection";

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const getCollection = (name) => mongoose.connection.db.collection(name);

const defaultMikrotikDcBatchConfig = () => ({
  Name: "Mikrotik DC Batch",
  SendTime: "09:00",
  IsActive: false,
  DisconnectedPlanName: DEFAULT_DISCONNECTED_PLAN,
  LastRunKey: "",
  LastRunAt: null,
  LastRunSummary: "",
  LastError: ""
});

const sanitizeConfig = (config) => {
  const defaults = defaultMikrotikDcBatchConfig();

  return {
    ...defaults,
    ...(config || {}),
    Name: String(config?.Name || defaults.Name).trim() || defaults.Name,
    SendTime: String(config?.SendTime || defaults.SendTime).trim() || defaults.SendTime,
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

const extractIpoeCommentName = (comment) => {
  const match = String(comment || "").match(/NAME=([^;]+)/i);
  return normalizeText(match?.[1] || "");
};

const extractIpoeCommentPlan = (comment) => {
  const match = String(comment || "").match(/PLAN=([^;]+)/i);
  return normalizeText(match?.[1] || "");
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

const buildSnapshotIndexes = (snapshot) => {
  const pppByName = new Map();
  const leaseByMac = new Map();
  const leaseByAccount = new Map();

  for (const secret of snapshot?.pppSecrets || []) {
    const name = normalizeText(secret?.name || secret?.Name);
    if (name) {
      pppByName.set(name, secret);
    }
  }

  for (const lease of snapshot?.dhcpLeases || []) {
    const macAddress = normalizeText(lease?.["mac-address"] || lease?.macAddress);
    const accountName = extractIpoeCommentName(lease?.comment);

    if (macAddress) {
      leaseByMac.set(macAddress, lease);
    }

    if (accountName && !leaseByAccount.has(accountName)) {
      leaseByAccount.set(accountName, lease);
    }
  }

  return {
    pppByName,
    leaseByMac,
    leaseByAccount
  };
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

const generateMikrotikDcBatchReport = async ({ applyChanges = false, triggeredBy = "" } = {}) => {
  const config = await getConfigDocument();
  const disconnectedPlanName =
    String(config.DisconnectedPlanName || DEFAULT_DISCONNECTED_PLAN).trim() ||
    DEFAULT_DISCONNECTED_PLAN;
  const clientCollection = getCollection(collections.clients);
  const clients = await clientCollection.find({}).toArray();
  const snapshot = await getMikrotikCheckerSnapshot();
  const indexes = buildSnapshotIndexes(snapshot);
  const rows = [];
  const updates = [];

  let checkedCount = 0;
  let disconnectedFoundCount = 0;
  let updatedCount = 0;
  let alreadyDisconnectedCount = 0;

  for (const client of clients) {
    const authMode = normalizeText(client?.AuthenticationMode);

    if (authMode !== "PPPOE" && authMode !== "IPOE") {
      continue;
    }

    checkedCount += 1;

    const accountKey = normalizeText(client?.AccountName);
    const macKey = normalizeText(client?.MacAddress || client?.macAddress);
    const oldProfile = String(client?.Profile || "").trim();
    const oldNetPlan = String(client?.NetPlan || "").trim();

    let disconnected = false;
    let detail = "";

    if (authMode === "PPPOE") {
      const secret = indexes.pppByName.get(accountKey);
      const profile = normalizeText(secret?.profile || secret?.Profile);

      if (profile === PPP_DISCONNECTED_PROFILE) {
        disconnected = true;
        detail = "MikroTik PPP secret profile is dc-putol.";
      }
    } else if (authMode === "IPOE") {
      const lease =
        (macKey && indexes.leaseByMac.get(macKey)) ||
        indexes.leaseByAccount.get(accountKey);
      const plan = extractIpoeCommentPlan(lease?.comment);

      if (plan === "0M/0M") {
        disconnected = true;
        detail = "MikroTik IPOE lease comment plan is 0M/0M.";
      }
    }

    if (!disconnected) {
      continue;
    }

    disconnectedFoundCount += 1;

    if (isSystemDisconnected(client)) {
      alreadyDisconnectedCount += 1;
      rows.push(
        buildRow({
          result: "ALREADY_DISCONNECTED",
          authMode,
          accountName: client?.AccountName,
          clientName: client?.ClientName,
          oldProfile,
          oldNetPlan,
          nextPlan: disconnectedPlanName,
          detail: `${detail} System record is already disconnected.`
        })
      );
      continue;
    }

    const updatePayload = {
      Profile: disconnectedPlanName,
      NetPlan: disconnectedPlanName,
      Status: "DISCONNECTED",
      updatedAt: new Date()
    };

    rows.push(
      buildRow({
        result: applyChanges ? "UPDATED_TO_DISCONNECTED" : "READY_TO_UPDATE",
        authMode,
        accountName: client?.AccountName,
        clientName: client?.ClientName,
        oldProfile,
        oldNetPlan,
        nextPlan: disconnectedPlanName,
        detail
      })
    );

    if (applyChanges && client?._id) {
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
        oldProfile,
        oldNetPlan,
        nextPlan: disconnectedPlanName
      });
    }
  }

  const generatedAt = new Date();
  const summary = {
    checkedCount,
    disconnectedFoundCount,
    updatedCount,
    alreadyDisconnectedCount,
    totalRows: rows.length
  };

  if (applyChanges) {
    const runSummary = `Checked ${checkedCount} client(s). MikroTik disconnected: ${disconnectedFoundCount}. Updated in system: ${updatedCount}.`;
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
