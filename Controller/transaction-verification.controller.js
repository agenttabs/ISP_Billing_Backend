const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const normalizePaymentMethod = (row) =>
  String(row.PaymentMethod || row.MOP || "")
    .trim()
    .toUpperCase();

const normalizeLineMethod = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeReferenceValue = (value) =>
  String(value || "")
    .replace(/\s+/g, "")
    .trim();

const normalizeCommentValue = (value) => String(value || "").trim();

const getPaymentBreakdownLines = (row) => {
  if (Array.isArray(row?.PaymentBreakdown) && row.PaymentBreakdown.length) {
    return row.PaymentBreakdown
      .map((line) => ({
        Method: normalizeLineMethod(line?.Method || line?.PaymentMethod),
        Amount: Number(line?.Amount || 0),
        Reference: normalizeReferenceValue(line?.Reference)
      }))
      .filter((line) => line.Method && line.Amount > 0);
  }

  const lines = [];
  const paymentMethod = normalizePaymentMethod(row);
  const cashAmount = Number(row?.CashAmount || 0);
  const gcashAmount = Number(row?.GCashAmount || 0);
  const fallbackReference =
    normalizeReferenceValue(row?.MOPRef) ||
    normalizeReferenceValue(row?.ReferenceNumber) ||
    normalizeReferenceValue(row?.TransactionCode) ||
    normalizeReferenceValue(row?.PaymentReceipt) ||
    normalizeReferenceValue(row?.Invoice);

  if (cashAmount > 0) {
    lines.push({
      Method: "CASH",
      Amount: cashAmount,
      Reference: ""
    });
  }

  if (gcashAmount > 0) {
    lines.push({
      Method: "GCASH",
      Amount: gcashAmount,
      Reference: fallbackReference
    });
  }

  if (!lines.length && paymentMethod) {
    lines.push({
      Method: paymentMethod,
      Amount: Number(row?.TotalAmount || row?.Cash || 0),
      Reference: paymentMethod === "CASH" ? "" : fallbackReference
    });
  }

  return lines.filter((line) => line.Amount > 0);
};

const getVerificationLine = (row) =>
  getPaymentBreakdownLines(row).find((line) => line.Method && line.Method !== "CASH") ||
  null;

const isNonCashPayment = (row) => {
  return Boolean(getVerificationLine(row));
};

exports.getPendingTransactions = async (_req, res) => {
  try {
    const rows = await mongoose.connection.db
      .collection(collections.print)
      .find({
        Type: "Payment",
        Verified: { $ne: true }
      })
      .sort({
        PaymentDate: -1,
        TransactionDate: -1,
        createdAt: -1
      })
      .toArray();

    const pendingTransactions = rows
      .filter(isNonCashPayment)
      .map((row) => {
        const verificationLine = getVerificationLine(row);
        const paymentBreakdown = getPaymentBreakdownLines(row);

        return {
          ...row,
          PaymentMethod: normalizePaymentMethod(row),
          PaymentBreakdown: paymentBreakdown,
          VerificationMethod: verificationLine?.Method || "",
          VerificationAmount: verificationLine?.Amount || 0,
          VerificationReference:
            verificationLine?.Reference ||
            normalizeReferenceValue(row.MOPRef) ||
            normalizeReferenceValue(row.ReferenceNumber) ||
            normalizeReferenceValue(row.TransactionCode) ||
            normalizeReferenceValue(row.PaymentReceipt) ||
            normalizeReferenceValue(row.Invoice),
          MatchReference:
            verificationLine?.Reference ||
            normalizeReferenceValue(row.MOPRef) ||
            normalizeReferenceValue(row.ReferenceNumber) ||
            normalizeReferenceValue(row.TransactionCode) ||
            normalizeReferenceValue(row.PaymentReceipt) ||
            normalizeReferenceValue(row.Invoice)
        };
      });

    res.json({
      count: pendingTransactions.length,
      records: pendingTransactions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.verifyTransactions = async (req, res) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];

    if (!records.length) {
      return res.status(400).json({ error: "No transaction records were provided." });
    }

    const validRecords = records.filter((record) => ObjectId.isValid(record?.id));

    if (!validRecords.length) {
      return res.status(400).json({ error: "No valid transaction ids were provided." });
    }

    const verifiedBy =
      req.user?.name || req.user?.username || req.user?.Name || req.user?.id || "";
    const verifiedById = req.user?.id || req.user?._id || "";
    const verifiedAt = new Date();

    const operations = validRecords.map((record) => ({
      updateOne: {
        filter: {
          _id: new ObjectId(record.id),
          Verified: { $ne: true }
        },
        update: {
          $set: {
            Verified: true,
            VerifiedAt: verifiedAt,
            VerifiedBy: verifiedBy,
            VerifiedById: verifiedById,
            VerificationMethod: String(record.method || "MANUAL")
              .trim()
              .toUpperCase(),
            VerifiedReference: normalizeReferenceValue(record.reference),
            VerificationComment: normalizeCommentValue(record.comment),
            updatedAt: verifiedAt
          }
        }
      }
    }));

    const result = await mongoose.connection.db
      .collection(collections.print)
      .bulkWrite(operations, { ordered: false });

    res.json({
      success: true,
      matchedCount: result.matchedCount || 0,
      modifiedCount: result.modifiedCount || 0
    });

    await writeAuditLog({
      req,
      module: "TRANSACTION_VERIFICATION",
      action: "VERIFY",
      targetType: "PRINT",
      status: "SUCCESS",
      summary: "Transaction verification completed.",
      details: {
        matchedCount: result.matchedCount || 0,
        modifiedCount: result.modifiedCount || 0
      },
      values: validRecords
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
