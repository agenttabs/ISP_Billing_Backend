const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const { replaceSmsTokens, sendDirectSms } = require("../services/sms.service");
const MANILA_TIMEZONE = "Asia/Manila";

const sanitizeBatchProgram = (program) => ({
  _id: program._id,
  Name: String(program.Name || "").trim(),
  TemplateType: String(program.TemplateType || "").trim(),
  RecipientRule: String(program.RecipientRule || "DUE_DATE").trim().toUpperCase(),
  DaysOffset: Number(program.DaysOffset || 0),
  SendTime: String(program.SendTime || "").trim(),
  Body: String(program.Body || ""),
  IsActive: Boolean(program.IsActive),
  RecipientCount: Number(program.RecipientCount || 0),
  LastRunKey: String(program.LastRunKey || "").trim(),
  LastRunAt: program.LastRunAt || null,
  LastRunSummary: String(program.LastRunSummary || "").trim(),
  LastError: String(program.LastError || "").trim()
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
    hour: Number(valueByType.hour || 0),
    minute: Number(valueByType.minute || 0),
    second: Number(valueByType.second || 0)
  };
};

const getManilaDateKey = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

const addDays = (value, days) => {
  const next = new Date(value);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
};

const getManilaDayUtcRange = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1, 16, 0, 0, 0));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

const getMinutesFromTimeKey = (value) => {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return hour * 60 + minute;
};

const hasContactNumber = (client) => Boolean(String(
  client?.ContactNumber || client?.Mobile || client?.Phone || ""
).trim());

const isDisconnectedClient = (client) => {
  const values = [client?.Profile, client?.NetPlan, client?.Status]
    .map((value) => String(value || "").trim().toUpperCase());

  return values.some((value) =>
    value.includes("DISCONNECTION") ||
    value.includes("DISCONNECTED") ||
    value === "DC-PUTOL" ||
    value === "0M/0M"
  );
};

const isUnpaidClient = (client) => {
  const paymentStatus = String(client?.PaymentStatus || "").trim().toUpperCase();
  const amountDue = Number(client?.AmountDue ?? client?.amountDue ?? 0);

  if (paymentStatus && paymentStatus !== "PAID") {
    return true;
  }

  return Number.isFinite(amountDue) && amountDue > 0;
};

const formatRecipientRow = (client) => ({
  _id: client?._id,
  ClientName: String(client?.ClientName || "").trim() || "-",
  AccountName: String(client?.AccountName || "").trim() || "-",
  AccountNumber: String(client?.AccountNumber || "").trim() || "-",
  ContactNumber: String(client?.ContactNumber || client?.Mobile || client?.Phone || "").trim() || "-",
  DueDate: client?.DueDate || null,
  AmountDue: Number(client?.AmountDue ?? client?.amountDue ?? 0) || 0,
  PaymentStatus: String(client?.PaymentStatus || "").trim() || "-",
  NetPlan: String(client?.NetPlan || client?.Profile || "").trim() || "-"
});

const formatCurrency = (value) =>
  `PHP ${Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

const formatDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: MANILA_TIMEZONE
  });
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
    ClientName: client?.ClientName || client?.AccountName || "",
    AccountName: client?.AccountName || "",
    AccountNumber: client?.AccountNumber || "",
    ContactNumber: client?.ContactNumber || client?.Mobile || client?.Phone || "",
    TotalAmountDue: formatCurrency(totalAmountDue),
    MonthlyDue: formatCurrency(monthlyDue),
    DueDate: formatDate(client?.DueDate),
    SubscriptionCover: subscriptionCover
  };
};

const filterProgramRecipients = (program, clients = []) => {
  const todayKey = getManilaDateKey();
  const daysOffset = Number(program?.DaysOffset || 0);

  return clients.filter((client) => {
    if (!hasContactNumber(client)) return false;
    if (isDisconnectedClient(client)) return false;
    if (!isUnpaidClient(client)) return false;

    const dueDate = client?.DueDate ? new Date(client.DueDate) : null;
    if (!dueDate || Number.isNaN(dueDate.getTime())) {
      return false;
    }

    const scheduledDate = addDays(dueDate, daysOffset);
    return getManilaDateKey(scheduledDate) === todayKey;
  });
};

const getProgramRecipients = async (program) => {
  const daysOffset = Number(program?.DaysOffset || 0);
  const targetDueDate = addDays(new Date(), -daysOffset);
  const { start, end } = getManilaDayUtcRange(targetDueDate);
  const clients = await mongoose.connection.db
    .collection(collections.clients)
    .find(
      {
        DueDate: { $gte: start, $lt: end },
        $or: [
          { ContactNumber: { $exists: true, $nin: ["", null] } },
          { Mobile: { $exists: true, $nin: ["", null] } },
          { Phone: { $exists: true, $nin: ["", null] } }
        ],
        $and: [
          {
            $or: [
              { PaymentStatus: { $exists: false } },
              { PaymentStatus: { $not: /^PAID$/i } },
              { AmountDue: { $gt: 0 } },
              { amountDue: { $gt: 0 } }
            ]
          }
        ],
        $nor: [
          { Profile: /DISCONNECTION|DISCONNECTED|^DC-PUTOL$|^0M\/0M$/i },
          { NetPlan: /DISCONNECTION|DISCONNECTED|^DC-PUTOL$|^0M\/0M$/i },
          { Status: /DISCONNECTION|DISCONNECTED|^DC-PUTOL$|^0M\/0M$/i }
        ]
      },
      {
        projection: {
          ClientName: 1,
          AccountName: 1,
          AccountNumber: 1,
          ContactNumber: 1,
          Mobile: 1,
          Phone: 1,
          DueDate: 1,
          AmountDue: 1,
          amountDue: 1,
          Balance: 1,
          PaymentStatus: 1,
          NetPlan: 1,
          Profile: 1,
          Status: 1,
          SubscriptionCover: 1
        }
      }
    )
    .toArray();

  return filterProgramRecipients(program, clients);
};

const updateProgramRunSummary = async (programId, values = {}) => {
  await mongoose.connection.db
    .collection(collections.smsBatchProgram)
    .updateOne(
      { _id: programId },
      {
        $set: {
          ...values,
          updatedAt: new Date()
        }
      }
    );
};

const executeSmsBatchProgram = async ({ program, action, req = null }) => {
  const recipients = await getProgramRecipients(program);
  let sent = 0;
  let skipped = 0;
  const errors = [];

  for (const client of recipients) {
    try {
      const message = replaceSmsTokens(String(program.Body || ""), buildTemplateValues(client));
      const result = await sendDirectSms({
        recipient: client?.ContactNumber || client?.Mobile || client?.Phone || "",
        message
      });

      if (result?.sent) {
        sent += 1;
      } else {
        skipped += 1;
        errors.push(
          `${client?.AccountName || client?.ClientName || "Client"}: ${result?.reason || "SMS skipped."}`
        );
      }
    } catch (err) {
      skipped += 1;
      errors.push(
        `${client?.AccountName || client?.ClientName || "Client"}: ${err.message}`
      );
    }
  }

  const now = new Date();
  const summary = `Sent ${sent} SMS, skipped ${skipped} SMS.`;
  const status = skipped > 0 && sent === 0 ? "FAILED" : "SUCCESS";

  await updateProgramRunSummary(program._id, {
    LastRunKey: getManilaDateKey(now),
    LastRunAt: now,
    LastRunSummary: summary,
    LastError: errors.length ? errors.slice(0, 5).join(" | ") : ""
  });

  await writeAuditLog({
    req,
    actor: req
      ? null
      : {
          name: "Scheduler",
          username: "scheduler",
          loginAccount: "scheduler",
          type: "SCHEDULER"
        },
    module: "SMS_BATCH",
    action,
    targetType: "SMS_BATCH_PROGRAM",
    targetId: program._id,
    status,
    summary: `SMS batch program ${action === "RUN_SCHEDULED" ? "scheduled run" : "run now"} executed. ${summary}`,
    details: {
      program: sanitizeBatchProgram(program),
      totalRecipients: recipients.length,
      errors
    }
  });

  return {
    sent,
    skipped,
    totalRecipients: recipients.length,
    reason: summary,
    errors
  };
};

exports.getSmsBatchPrograms = async (_req, res) => {
  try {
    const programs = await mongoose.connection.db
      .collection(collections.smsBatchProgram)
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json(programs.map(sanitizeBatchProgram));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createSmsBatchProgram = async (req, res) => {
  try {
    const Name = String(req.body.Name || "").trim();
    const TemplateType = String(req.body.TemplateType || "").trim();
    const RecipientRule = String(req.body.RecipientRule || "DUE_DATE")
      .trim()
      .toUpperCase();
    const DaysOffset = Number(req.body.DaysOffset || 0);
    const SendTime = String(req.body.SendTime || "").trim();
    const Body = String(req.body.Body || "");
    const IsActive = Boolean(req.body.IsActive);

    if (!Name || !TemplateType || !Body.trim() || !SendTime) {
      return res.status(400).json({
        error: "Name, TemplateType, SendTime, and Body are required."
      });
    }

    const collection = mongoose.connection.db.collection(collections.smsBatchProgram);
    const duplicate = await collection.findOne({
      Name: { $regex: new RegExp(`^${Name}$`, "i") }
    });

    if (duplicate) {
      return res.status(409).json({
        error: "A batch program with this name already exists."
      });
    }

    const payload = {
      Name,
      TemplateType,
      RecipientRule,
      DaysOffset,
      SendTime,
      Body,
      IsActive,
      LastRunKey: "",
      LastRunAt: null,
      LastRunSummary: "",
      LastError: "",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await collection.insertOne(payload);

    res.status(201).json({
      ...sanitizeBatchProgram(payload),
      _id: result.insertedId
    });

    await writeAuditLog({
      req,
      module: "SMS_BATCH",
      action: "CREATE_PROGRAM",
      targetType: "SMS_BATCH_PROGRAM",
      targetId: result.insertedId,
      status: "SUCCESS",
      summary: "SMS batch program created.",
      values: sanitizeBatchProgram(payload)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateSmsBatchProgram = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid batch program id." });
    }

    const Name = String(req.body.Name || "").trim();
    const TemplateType = String(req.body.TemplateType || "").trim();
    const RecipientRule = String(req.body.RecipientRule || "DUE_DATE")
      .trim()
      .toUpperCase();
    const DaysOffset = Number(req.body.DaysOffset || 0);
    const SendTime = String(req.body.SendTime || "").trim();
    const Body = String(req.body.Body || "");
    const IsActive = Boolean(req.body.IsActive);

    if (!Name || !TemplateType || !Body.trim() || !SendTime) {
      return res.status(400).json({
        error: "Name, TemplateType, SendTime, and Body are required."
      });
    }

    const collection = mongoose.connection.db.collection(collections.smsBatchProgram);
    const objectId = new mongoose.Types.ObjectId(id);
    const duplicate = await collection.findOne({
      _id: { $ne: objectId },
      Name: { $regex: new RegExp(`^${Name}$`, "i") }
    });

    if (duplicate) {
      return res.status(409).json({
        error: "Another batch program already uses this name."
      });
    }

    const update = {
      $set: {
        Name,
        TemplateType,
        RecipientRule,
        DaysOffset,
        SendTime,
        Body,
        IsActive,
        updatedAt: new Date()
      }
    };

    const updateResult = await collection.updateOne(
      { _id: objectId },
      update
    );

    if (!updateResult.matchedCount) {
      return res.status(404).json({ error: "Batch program not found." });
    }

    const updatedProgram = await collection.findOne({ _id: objectId });

    res.json(sanitizeBatchProgram(updatedProgram));

    await writeAuditLog({
      req,
      module: "SMS_BATCH",
      action: "UPDATE_PROGRAM",
      targetType: "SMS_BATCH_PROGRAM",
      targetId: id,
      status: "SUCCESS",
      summary: "SMS batch program updated.",
      values: sanitizeBatchProgram(updatedProgram)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getSmsBatchProgramRecipients = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid batch program id." });
    }

    const objectId = new mongoose.Types.ObjectId(id);
    const program = await mongoose.connection.db
      .collection(collections.smsBatchProgram)
      .findOne({ _id: objectId });

    if (!program) {
      return res.status(404).json({ error: "Batch program not found." });
    }

    const recipients = await getProgramRecipients(program);

    res.json({
      program: sanitizeBatchProgram(program),
      totalRecipients: recipients.length,
      recipients: recipients.map(formatRecipientRow)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.runSmsBatchProgramNow = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid batch program id." });
    }

    const objectId = new mongoose.Types.ObjectId(id);
    const program = await mongoose.connection.db
      .collection(collections.smsBatchProgram)
      .findOne({ _id: objectId });

    if (!program) {
      return res.status(404).json({ error: "Batch program not found." });
    }

    const result = await executeSmsBatchProgram({
      program,
      action: "RUN_NOW",
      req
    });

    res.json({
      sent: result.sent,
      skipped: result.skipped,
      totalRecipients: result.totalRecipients,
      reason: result.reason,
      errors: result.errors
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

let schedulerHandle = null;
let schedulerBusy = false;

const runScheduledSmsBatchPrograms = async () => {
  if (schedulerBusy) {
    return;
  }

  schedulerBusy = true;

  try {
    const now = new Date();
    const parts = getManilaDateParts(now);
    const currentMinutes = parts.hour * 60 + parts.minute;
    const todayKey = getManilaDateKey(now);
    const programs = await mongoose.connection.db
      .collection(collections.smsBatchProgram)
      .find({ IsActive: true })
      .toArray();

    for (const program of programs) {
      const targetMinutes = getMinutesFromTimeKey(program.SendTime);

      if (targetMinutes === null) {
        continue;
      }

      if (currentMinutes < targetMinutes || String(program.LastRunKey || "") === todayKey) {
        continue;
      }

      console.log(`SMS BATCH SCHEDULER RUNNING: ${program.Name || program._id}`);

      try {
        await executeSmsBatchProgram({
          program,
          action: "RUN_SCHEDULED"
        });
      } catch (err) {
        console.error("SMS BATCH PROGRAM ERROR:", err.message);
        await updateProgramRunSummary(program._id, {
          LastRunKey: todayKey,
          LastRunAt: new Date(),
          LastRunSummary: "Scheduled SMS batch failed.",
          LastError: err.message
        });
      }
    }
  } catch (err) {
    console.error("SMS BATCH SCHEDULER ERROR:", err.message);
  } finally {
    schedulerBusy = false;
  }
};

const startSmsBatchScheduler = () => {
  if (schedulerHandle) {
    return;
  }

  schedulerHandle = setInterval(runScheduledSmsBatchPrograms, 60 * 1000);
  setTimeout(runScheduledSmsBatchPrograms, 10000);
  console.log("SMS BATCH SCHEDULER STARTED");
};

exports.startSmsBatchScheduler = startSmsBatchScheduler;
