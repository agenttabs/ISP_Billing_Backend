const mongoose = require("mongoose");
const collections = require("../config/collections");

const REDACTED_KEYS = new Set([
  "password",
  "smtppassword",
  "token",
  "jwttoken",
  "telegramtoken",
  "api",
  "apikey",
  "secret"
]);

const cleanString = (value) => String(value || "").trim();

const safeClone = (value, depth = 0) => {
  if (depth > 4) {
    return "[truncated]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => safeClone(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, entryValue]) => {
      const normalizedKey = cleanString(key).toLowerCase();
      acc[key] = REDACTED_KEYS.has(normalizedKey)
        ? "***"
        : safeClone(entryValue, depth + 1);
      return acc;
    }, {});
  }

  return value;
};

const getActorFromRequest = (req) => ({
  userId: cleanString(req?.user?.id || req?.user?._id || req?.user?.ID),
  name: cleanString(req?.user?.name || req?.user?.Name),
  username: cleanString(req?.user?.username || req?.user?.Username),
  type: cleanString(req?.user?.type || req?.user?.role || req?.user?.Type),
  loginAccount: cleanString(
    req?.user?.username ||
      req?.user?.Username ||
      req?.body?.username ||
      req?.body?.Username
  )
});

const writeAuditLog = async ({
  req,
  actor,
  module,
  action,
  targetType = "",
  targetId = "",
  accountName = "",
  status = "SUCCESS",
  summary = "",
  details = null,
  values = null
}) => {
  try {
    const db = mongoose.connection.db;

    if (!db) {
      return;
    }

    const actorPayload = actor || getActorFromRequest(req);
    const payload = {
      Module: cleanString(module),
      Action: cleanString(action),
      TargetType: cleanString(targetType),
      TargetId: cleanString(targetId),
      AccountName: cleanString(accountName),
      Status: cleanString(status).toUpperCase() || "SUCCESS",
      Summary: cleanString(summary),
      Actor: safeClone(actorPayload),
      Values: safeClone(values),
      Details: safeClone(details),
      Request: req
        ? {
            method: cleanString(req.method),
            path: cleanString(req.originalUrl || req.url),
            ip: cleanString(req.ip),
            userAgent: cleanString(req.get?.("user-agent"))
          }
        : {},
      createdAt: new Date()
    };

    await db.collection(collections.systemLogs).insertOne(payload);
  } catch (err) {
    console.error("AUDIT LOG WRITE ERROR:", err.message);
  }
};

module.exports = {
  writeAuditLog,
  getActorFromRequest,
  safeClone
};
